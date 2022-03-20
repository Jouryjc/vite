import fs from 'fs'
import path from 'path'
import colors from 'picocolors'
import { createHash } from 'crypto'
import type { BuildOptions as EsbuildBuildOptions } from 'esbuild'
import { build } from 'esbuild'
import type { ResolvedConfig } from '../config'
import {
  createDebugger,
  emptyDir,
  lookupFile,
  normalizePath,
  writeFile,
  flattenId,
  normalizeId
} from '../utils'
import { esbuildDepPlugin } from './esbuildDepPlugin'
import { init, parse } from 'es-module-lexer'
import { scanImports } from './scan'
import { transformWithEsbuild } from '../plugins/esbuild'
import { performance } from 'perf_hooks'

const debug = createDebugger('vite:deps')

export type ExportsData = ReturnType<typeof parse> & {
  // es-module-lexer has a facade detection but isn't always accurate for our
  // use case when the module has default export
  hasReExports?: true
}

export interface DepOptimizationOptions {
  /**
   * By default, Vite will crawl your `index.html` to detect dependencies that
   * need to be pre-bundled. If `build.rollupOptions.input` is specified, Vite
   * will crawl those entry points instead.
   *
   * If neither of these fit your needs, you can specify custom entries using
   * this option - the value should be a fast-glob pattern or array of patterns
   * (https://github.com/mrmlnc/fast-glob#basic-syntax) that are relative from
   * vite project root. This will overwrite default entries inference.
   */
  entries?: string | string[]
  /**
   * Force optimize listed dependencies (must be resolvable import paths,
   * cannot be globs).
   */
  include?: string[]
  /**
   * Do not optimize these dependencies (must be resolvable import paths,
   * cannot be globs).
   */
  exclude?: string[]
  /**
   * Options to pass to esbuild during the dep scanning and optimization
   *
   * Certain options are omitted since changing them would not be compatible
   * with Vite's dep optimization.
   *
   * - `external` is also omitted, use Vite's `optimizeDeps.exclude` option
   * - `plugins` are merged with Vite's dep plugin
   * - `keepNames` takes precedence over the deprecated `optimizeDeps.keepNames`
   *
   * https://esbuild.github.io/api
   */
  esbuildOptions?: Omit<
    EsbuildBuildOptions,
    | 'bundle'
    | 'entryPoints'
    | 'external'
    | 'write'
    | 'watch'
    | 'outdir'
    | 'outfile'
    | 'outbase'
    | 'outExtension'
    | 'metafile'
  >
  /**
   * @deprecated use `esbuildOptions.keepNames`
   */
  keepNames?: boolean
}

export interface DepOptimizationMetadata {
  /**
   * The main hash is determined by user config and dependency lockfiles.
   * This is checked on server startup to avoid unnecessary re-bundles.
   */
  hash: string
  /**
   * The browser hash is determined by the main hash plus additional dependencies
   * discovered at runtime. This is used to invalidate browser requests to
   * optimized deps.
   */
  browserHash: string
  optimized: Record<
    string,
    {
      file: string
      src: string
      needsInterop: boolean
    }
  >
}

/**
 * 依赖预编译
 * @param {ResolvedConfig} config 
 * @param {boolean} force 强制刷新缓存变量
 * @param {boolean} asCommand
 * @param {Record<string, string>} newDeps 新的依赖
 * @param {boolean} ssr
 */
export async function optimizeDeps(
  config: ResolvedConfig,
  force = config.server.force,
  asCommand = false,
  newDeps?: Record<string, string>, // missing imports encountered after server has started
  ssr?: boolean
): Promise<DepOptimizationMetadata | null> {
  config = {
    ...config,
    command: 'build'
  }

  const { root, logger, cacheDir } = config
  const log = asCommand ? logger.info : debug

  // 缓存文件信息
  const dataPath = path.join(cacheDir, '_metadata.json')
  // 获取依赖的hash，这里的依赖是 lock 文件、以及 config 的部分信息
  const mainHash = getDepHash(root, config)
  // 定义预编译优化的元数据
  const data: DepOptimizationMetadata = {
    hash: mainHash,
    browserHash: mainHash,
    optimized: {}
  }

  // 不强制刷新
  if (!force) {
    let prevData: DepOptimizationMetadata | undefined
    try {
      // 读取 metadata 信息
      prevData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'))
    } catch (e) {}
    // hash is consistent, no need to re-bundle
    if (prevData && prevData.hash === data.hash) {
      log('Hash is consistent. Skipping. Use --force to override.')
      return prevData
    }
  }

  // 存在缓存目录，清空目录
  if (fs.existsSync(cacheDir)) {
    emptyDir(cacheDir)
  } else {
    // 创建多层级缓存目录
    fs.mkdirSync(cacheDir, { recursive: true })
  }
  // a hint for Node.js
  // all files in the cache directory should be recognized as ES modules
  // 缓存目录的模块要被识别成 ESM
  writeFile(
    path.resolve(cacheDir, 'package.json'),
    JSON.stringify({ type: 'module' })
  )

  let deps: Record<string, string>, missing: Record<string, string>
  // 没有新的依赖的情况，扫描并预构建全部的 import
  if (!newDeps) {
    ;({ deps, missing } = await scanImports(config))
  } else {
    deps = newDeps
    missing = {}
  }

  // update browser hash
  data.browserHash = createHash('sha256')
    .update(data.hash + JSON.stringify(deps))
    .digest('hex')
    .substring(0, 8)

  // 遗漏的包
  const missingIds = Object.keys(missing)
  if (missingIds.length) {
    throw new Error(
      `The following dependencies are imported but could not be resolved:\n\n  ${missingIds
        .map(
          (id) =>
            `${colors.cyan(id)} ${colors.white(
              colors.dim(`(imported by ${missing[id]})`)
            )}`
        )
        .join(`\n  `)}\n\nAre they installed?`
    )
  }

  // 获取 optimizeDeps?.include 配置
  const include = config.optimizeDeps?.include
  if (include) {
    const resolve = config.createResolver({ asSrc: false })
    for (const id of include) {
      // normalize 'foo   >bar` as 'foo > bar' to prevent same id being added
      // and for pretty printing
      const normalizedId = normalizeId(id)
      if (!deps[normalizedId]) {
        const entry = await resolve(id)
        if (entry) {
          deps[normalizedId] = entry
        } else {
          throw new Error(
            `Failed to resolve force included dependency: ${colors.cyan(id)}`
          )
        }
      }
    }
  }

  const qualifiedIds = Object.keys(deps)

  // 没有依赖的情况
  if (!qualifiedIds.length) {
    writeFile(dataPath, JSON.stringify(data, null, 2))
    log(`No dependencies to bundle. Skipping.\n\n\n`)
    return data
  }

  const total = qualifiedIds.length
  // pre-bundling 的列表最多展示 5 项
  const maxListed = 5
  // 列表数量
  const listed = Math.min(total, maxListed)
  // 剩余的数量
  const extra = Math.max(0, total - maxListed)
  // 预编译依赖的信息
  const depsString = colors.yellow(
    qualifiedIds.slice(0, listed).join(`\n  `) +
      (extra > 0 ? `\n  (...and ${extra} more)` : ``)
  )
  if (!asCommand) {
    if (!newDeps) {
      // This is auto run on server start - let the user know that we are
      // pre-optimizing deps
      logger.info(colors.green(`Pre-bundling dependencies:\n  ${depsString}`))
      logger.info(
        `(this will be run only when your dependencies or config have changed)`
      )
    }
  } else {
    logger.info(colors.green(`Optimizing dependencies:\n  ${depsString}`))
  }

  // esbuild generates nested directory output with lowest common ancestor base
  // this is unpredictable and makes it difficult to analyze entry / output
  // mapping. So what we do here is:
  // 1. flatten all ids to eliminate slash
  // 2. in the plugin, read the entry ourselves as virtual files to retain the
  //    path.
  // 拍平的依赖IDs
  const flatIdDeps: Record<string, string> = {}
  // id <--> export
  const idToExports: Record<string, ExportsData> = {}
  // 拍平的id <--> export
  const flatIdToExports: Record<string, ExportsData> = {}

  const { plugins = [], ...esbuildOptions } =
    config.optimizeDeps?.esbuildOptions ?? {}

  await init
  for (const id in deps) {
    const flatId = flattenId(id)
    const filePath = (flatIdDeps[flatId] = deps[id])
    const entryContent = fs.readFileSync(filePath, 'utf-8') // 读取依赖内容
    let exportsData: ExportsData
    try {
      exportsData = parse(entryContent) as ExportsData
    } catch {
      debug(
        `Unable to parse dependency: ${id}. Trying again with a JSX transform.`
      )
      const transformed = await transformWithEsbuild(entryContent, filePath, {
        loader: 'jsx'
      })
      // Ensure that optimization won't fail by defaulting '.js' to the JSX parser.
      // This is useful for packages such as Gatsby.
      esbuildOptions.loader = {
        '.js': 'jsx',
        ...esbuildOptions.loader
      }
      exportsData = parse(transformed.code) as ExportsData
    }
    // ss -> export start  se -> export end
    for (const { ss, se } of exportsData[0]) {
      const exp = entryContent.slice(ss, se)
      // 存在复合写法
      if (/export\s+\*\s+from/.test(exp)) {
        exportsData.hasReExports = true
      }
    }
    idToExports[id] = exportsData
    flatIdToExports[flatId] = exportsData
  }

  const define: Record<string, string> = {
    'process.env.NODE_ENV': JSON.stringify(config.mode)
  }
  for (const key in config.define) {
    const value = config.define[key]
    define[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }

  const start = performance.now()

  // 执行预编译
  const result = await build({
    // 绝对路径的工作目录（项目根目录）
    absWorkingDir: process.cwd(),
    // 入口点
    entryPoints: Object.keys(flatIdDeps),
    // 集合，将全部文件构建后内联到入口文件
    bundle: true,
    // 输出文件格式，支持 iife、cjs、esm
    format: 'esm',
    // 打包后的支持的环境目标
    target: config.build.target || undefined,
    // 排除某些依赖的打包
    external: config.optimizeDeps?.exclude,
    // 日志级别，只显示错误信息
    logLevel: 'error',
    // 代码拆分
    splitting: true,
    sourcemap: true,
    // 构建输出目录，默认是 node_modules/.vite
    outdir: cacheDir,
    // 忽略副作用注释
    ignoreAnnotations: true,
    // 输出构建文件
    metafile: true,
    // 全局声明
    define,
    // 插件
    plugins: [
      ...plugins,
      esbuildDepPlugin(flatIdDeps, flatIdToExports, config, ssr)
    ],
    ...esbuildOptions
  })

  const meta = result.metafile!

  // the paths in `meta.outputs` are relative to `process.cwd()`
  const cacheDirOutputPath = path.relative(process.cwd(), cacheDir)

  // 更新 optimized 信息
  for (const id in deps) {
    const entry = deps[id]
    data.optimized[id] = {
      file: normalizePath(path.resolve(cacheDir, flattenId(id) + '.js')),
      src: entry,
      needsInterop: needsInterop(
        id,
        idToExports[id],
        meta.outputs,
        cacheDirOutputPath
      )
    }
  }

  // 预编译结果写入metadata文件
  writeFile(dataPath, JSON.stringify(data, null, 2))

  debug(`deps bundled in ${(performance.now() - start).toFixed(2)}ms`)
  return data
}

// https://github.com/vitejs/vite/issues/1724#issuecomment-767619642
// a list of modules that pretends to be ESM but still uses `require`.
// this causes esbuild to wrap them as CJS even when its entry appears to be ESM.
const KNOWN_INTEROP_IDS = new Set(['moment'])

function needsInterop(
  id: string,
  exportsData: ExportsData,
  outputs: Record<string, any>,
  cacheDirOutputPath: string
): boolean {
  if (KNOWN_INTEROP_IDS.has(id)) {
    return true
  }
  const [imports, exports] = exportsData
  // entry has no ESM syntax - likely CJS or UMD
  if (!exports.length && !imports.length) {
    return true
  }

  // if a peer dependency used require() on a ESM dependency, esbuild turns the
  // ESM dependency's entry chunk into a single default export... detect
  // such cases by checking exports mismatch, and force interop.
  const flatId = flattenId(id) + '.js'
  let generatedExports: string[] | undefined
  for (const output in outputs) {
    if (
      normalizePath(output) ===
      normalizePath(path.join(cacheDirOutputPath, flatId))
    ) {
      generatedExports = outputs[output].exports
      break
    }
  }

  if (
    !generatedExports ||
    (isSingleDefaultExport(generatedExports) && !isSingleDefaultExport(exports))
  ) {
    return true
  }
  return false
}

function isSingleDefaultExport(exports: readonly string[]) {
  return exports.length === 1 && exports[0] === 'default'
}

const lockfileFormats = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']


/**
 * 获取依赖的 hash 值
 *
 * @param {string} root 根目录
 * @param {ResolvedConfig} config 服务配置信息
 * @return {*}  {string}
 */
function getDepHash(root: string, config: ResolvedConfig): string {
  let content = lookupFile(root, lockfileFormats) || ''
  // also take config into account
  // only a subset of config options that can affect dep optimization
  content += JSON.stringify(
    {
      mode: config.mode,
      root: config.root,
      resolve: config.resolve,
      assetsInclude: config.assetsInclude,
      plugins: config.plugins.map((p) => p.name),
      optimizeDeps: {
        include: config.optimizeDeps?.include,
        exclude: config.optimizeDeps?.exclude
      }
    },
    (_, value) => {
      if (typeof value === 'function' || value instanceof RegExp) {
        return value.toString()
      }
      return value
    }
  )
  return createHash('sha256').update(content).digest('hex').substring(0, 8)
}
