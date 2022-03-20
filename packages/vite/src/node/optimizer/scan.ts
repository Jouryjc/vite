import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import type { ResolvedConfig } from '..'
import type { Loader, Plugin, OnLoadResult } from 'esbuild'
import { build, transform } from 'esbuild'
import {
  KNOWN_ASSET_TYPES,
  JS_TYPES_RE,
  SPECIAL_QUERY_RE,
  OPTIMIZABLE_ENTRY_RE
} from '../constants'
import {
  createDebugger,
  normalizePath,
  isObject,
  cleanUrl,
  moduleListContains,
  externalRE,
  dataUrlRE,
  multilineCommentsRE,
  singlelineCommentsRE,
  virtualModuleRE,
  virtualModulePrefix
} from '../utils'
import type { PluginContainer } from '../server/pluginContainer'
import { createPluginContainer } from '../server/pluginContainer'
import { init, parse } from 'es-module-lexer'
import MagicString from 'magic-string'
import { transformImportGlob } from '../importGlob'
import { performance } from 'perf_hooks'
import colors from 'picocolors'

const debug = createDebugger('vite:deps')

const htmlTypesRE = /\.(html|vue|svelte|astro)$/

const setupRE = /<script\s+setup/

// A simple regex to detect import sources. This is only used on
// <script lang="ts"> blocks in vue (setup only) or svelte files, since
// seemingly unused imports are dropped by esbuild when transpiling TS which
// prevents it from crawling further.
// We can't use es-module-lexer because it can't handle TS, and don't want to
// use Acorn because it's slow. Luckily this doesn't have to be bullet proof
// since even missed imports can be caught at runtime, and false positives will
// simply be ignored.
export const importsRE =
  /(?<!\/\/.*)(?<=^|;|\*\/)\s*import(?!\s+type)(?:[\w*{}\n\r\t, ]+from\s*)?\s*("[^"]+"|'[^']+')\s*(?=$|;|\/\/|\/\*)/gm

/**
 * 扫描全部引用
 * @param {ResolvedConfig} config
 */
export async function scanImports(config: ResolvedConfig): Promise<{
  deps: Record<string, string>
  missing: Record<string, string>
}> {
  const start = performance.now()

  let entries: string[] = []

  // 预构建自定义条目
  const explicitEntryPatterns = config.optimizeDeps.entries
  // rollup 入口点
  const buildInput = config.build.rollupOptions?.input

  // 自定义条目优先级最高
  if (explicitEntryPatterns) {
    entries = await globEntries(explicitEntryPatterns, config)
  // 其次是 rollup 的 build 入口
  } else if (buildInput) {
    const resolvePath = (p: string) => path.resolve(config.root, p)
    if (typeof buildInput === 'string') {
      entries = [resolvePath(buildInput)]
    } else if (Array.isArray(buildInput)) {
      entries = buildInput.map(resolvePath)
    } else if (isObject(buildInput)) {
      entries = Object.values(buildInput).map(resolvePath)
    } else {
      throw new Error('invalid rollupOptions.input value.')
    }
  // 默认情况下，Vite 会抓取你的 index.html 来检测需要预构建的依赖项
  } else {
    entries = await globEntries('**/*.html', config)
  }

  // Non-supported entry file types and virtual files should not be scanned for
  // dependencies.
  // 合法的入口文件是 js 或者 html
  entries = entries.filter(
    (entry) =>
      (JS_TYPES_RE.test(entry) || htmlTypesRE.test(entry)) &&
      fs.existsSync(entry)
  )

  // 找不到需要预构建的入口
  if (!entries.length) {
    if (!explicitEntryPatterns && !config.optimizeDeps.include) {
      config.logger.warn(
        colors.yellow(
          '(!) Could not auto-determine entry point from rollupOptions or html files ' +
            'and there are no explicit optimizeDeps.include patterns. ' +
            'Skipping dependency pre-bundling.'
        )
      )
    }
    return { deps: {}, missing: {} }
  } else {
    debug(`Crawling dependencies using entries:\n  ${entries.join('\n  ')}`)
  }

  // 依赖
  const deps: Record<string, string> = {}
  // 缺失的依赖
  const missing: Record<string, string> = {}
  // 创建插件容器，为什么这里需要单独创建一个插件容器？而不是使用 createServer 时创建的那个
  const container = await createPluginContainer(config)
  // 创建 esbuild 扫描的插件
  const plugin = esbuildScanPlugin(config, container, deps, missing, entries)
  // 外部传入的 esbuild 配置
  const { plugins = [], ...esbuildOptions } =
    config.optimizeDeps?.esbuildOptions ?? {}

  // 遍历所有入口全部进行预构建
  await Promise.all(
    entries.map((entry) =>
      build({
        absWorkingDir: process.cwd(),
        write: false,
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
        logLevel: 'error',
        plugins: [...plugins, plugin],
        ...esbuildOptions
      })
    )
  )

  debug(`Scan completed in ${(performance.now() - start).toFixed(2)}ms:`, deps)

  return {
    deps,
    missing
  }
}

function globEntries(pattern: string | string[], config: ResolvedConfig) {
  return glob(pattern, {
    cwd: config.root,
    ignore: [
      '**/node_modules/**',
      `**/${config.build.outDir}/**`,
      `**/__tests__/**`
    ],
    absolute: true
  })
}

// 匹配 html <script type="module"> 的形式
const scriptModuleRE =
  /(<script\b[^>]*type\s*=\s*(?:"module"|'module')[^>]*>)(.*?)<\/script>/gims
// 匹配 vue <script> 的形式
export const scriptRE = /(<script\b(?:\s[^>]*>|>))(.*?)<\/script>/gims
// 匹配 html 中的注释
export const commentRE = /<!--(.|[\r\n])*?-->/
// 匹配 src 的内容
const srcRE = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/im
// 匹配 type 的内容
const typeRE = /\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/im
// 匹配 lang 的内容
const langRE = /\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/im
// 匹配 context 的内容
const contextRE = /\bcontext\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/im

/**
 * esbuid 扫描依赖插件
 *
 * @param {ResolvedConfig} config 配置信息
 * @param {PluginContainer} container 插件容器
 * @param {Record<string, string>} depImports 预构建的依赖
 * @param {Record<string, string>} missing 缺失的依赖
 * @param {string[]} entries optimizeDeps.entries 的数据
 * @return {*}  {Plugin}
 */
function esbuildScanPlugin(
  config: ResolvedConfig,
  container: PluginContainer,
  depImports: Record<string, string>,
  missing: Record<string, string>,
  entries: string[]
): Plugin {
  const seen = new Map<string, string | undefined>()

  const resolve = async (id: string, importer?: string) => {
    const key = id + (importer && path.dirname(importer))
    if (seen.has(key)) {
      return seen.get(key)
    }
    const resolved = await container.resolveId(
      id,
      importer && normalizePath(importer)
    )
    const res = resolved?.id
    seen.set(key, res)
    return res
  }

  // 获取 optimizeDeps.include 配置
  const include = config.optimizeDeps?.include
  // 排除预构建的文件
  const exclude = [
    ...(config.optimizeDeps?.exclude || []),
    '@vite/client',
    '@vite/env'
  ]

  // 排除没有用的入口
  const externalUnlessEntry = ({ path }: { path: string }) => ({
    path,
    external: !entries.includes(path)
  })
  // 返回 esbuild 的插件
  return {
    name: 'vite:dep-scan',
    setup(build) {
      console.log('build options ------->', build.initialOptions)

      const localScripts: Record<string, OnLoadResult> = {}

      // external urls
      build.onResolve({ filter: externalRE }, ({ path }) => ({
        path,
        external: true
      }))

      // data urls
      build.onResolve({ filter: dataUrlRE }, ({ path }) => ({
        path,
        external: true
      }))

      // local scripts (`<script>` in Svelte and `<script setup>` in Vue)
      build.onResolve({ filter: virtualModuleRE }, ({ path }) => {
        console.log('virtual module resolved -------------->', path)
        return {
          // strip prefix to get valid filesystem path so esbuild can resolve imports in the file
          path: path.replace(virtualModulePrefix, ''),
          namespace: 'local-script'
        }
      })

      build.onLoad({ filter: /.*/, namespace: 'local-script' }, ({ path }) => {
        return localScripts[path]
      })

      // html types: extract script contents -----------------------------------
      build.onResolve({ filter: htmlTypesRE }, async ({ path, importer }) => {
        console.log('html type resolve --------------->', path)
        return {
          path: await resolve(path, importer),
          namespace: 'html'
        }
      })

      // extract scripts inside HTML-like files and treat it as a js module
      build.onLoad(
        { filter: htmlTypesRE, namespace: 'html' },
        async ({ path }) => {
          console.log('html type load  --------------->', path)
          let raw = fs.readFileSync(path, 'utf-8')
          // Avoid matching the content of the comment
          // 注释文字全部删掉
          raw = raw.replace(commentRE, '<!---->')
          // 是不是 html 文件，也可能是 vue、svelte 等
          const isHtml = path.endsWith('.html')
          // 是 html 文件就用 script module 正则，否则
          const regex = isHtml ? scriptModuleRE : scriptRE
          regex.lastIndex = 0
          let js = ''
          let loader: Loader = 'js'
          let match: RegExpExecArray | null
          while ((match = regex.exec(raw))) {
            const [, openTag, content] = match  // openTag 开始标签的内容（包含属性）
            const typeMatch = openTag.match(typeRE) // 找到 type 的值
            const type =
              typeMatch && (typeMatch[1] || typeMatch[2] || typeMatch[3])
            const langMatch = openTag.match(langRE) // 匹配语言
            const lang =
              langMatch && (langMatch[1] || langMatch[2] || langMatch[3])
            // skip type="application/ld+json" and other non-JS types
            if (
              type &&
              !(
                type.includes('javascript') ||
                type.includes('ecmascript') ||
                type === 'module'
              )
            ) {
              continue
            }
            if (lang === 'ts' || lang === 'tsx' || lang === 'jsx') {
              loader = lang
            }
            const srcMatch = openTag.match(srcRE) // 匹配 src
            if (srcMatch) {
              const src = srcMatch[1] || srcMatch[2] || srcMatch[3]
              js += `import ${JSON.stringify(src)}\n`
            } else if (content.trim()) {
              // There can be module scripts (`<script context="module">` in Svelte and `<script>` in Vue)
              // or local scripts (`<script>` in Svelte and `<script setup>` in Vue)
              // We need to handle these separately in case variable names are reused between them
              const contextMatch = openTag.match(contextRE)
              const context =
                contextMatch &&
                (contextMatch[1] || contextMatch[2] || contextMatch[3])
              if (
                (path.endsWith('.vue') && setupRE.test(openTag)) ||
                (path.endsWith('.svelte') && context !== 'module')
              ) {
                // append imports in TS to prevent esbuild from removing them
                // since they may be used in the template
                const localContent =
                  content +
                  (loader.startsWith('ts') ? extractImportPaths(content) : '')
                localScripts[path] = {
                  loader,
                  contents: localContent
                }
                js += `import ${JSON.stringify(virtualModulePrefix + path)}\n`
              } else {
                js += content + '\n'
              }
            }
          }

          // `<script>` in Svelte has imports that can be used in the template
          // so we handle them here too
          if (loader.startsWith('ts') && path.endsWith('.svelte')) {
            js += extractImportPaths(js)
          }

          // This will trigger incorrectly if `export default` is contained
          // anywhere in a string. Svelte and Astro files can't have
          // `export default` as code so we know if it's encountered it's a
          // false positive (e.g. contained in a string)
          if (!path.endsWith('.vue') || !js.includes('export default')) {
            js += '\nexport default {}'
          }

          if (js.includes('import.meta.glob')) {
            return {
              // transformGlob already transforms to js
              loader: 'js',
              contents: await transformGlob(js, path, config.root, loader)
            }
          }

          return {
            loader,
            contents: js
          }
        }
      )

      // bare imports: record and externalize ----------------------------------
      build.onResolve(
        {
          // avoid matching windows volume
          filter: /^[\w@][^:]/
        },
        async ({ path: id, importer }) => {
          console.log('bare imports --------------->', id)
          if (moduleListContains(exclude, id)) {
            return externalUnlessEntry({ path: id })
          }
          if (depImports[id]) {
            return externalUnlessEntry({ path: id })
          }
          const resolved = await resolve(id, importer)
          if (resolved) {
            if (shouldExternalizeDep(resolved, id)) {
              return externalUnlessEntry({ path: id })
            }
            if (resolved.includes('node_modules') || include?.includes(id)) {
              // dependency or forced included, externalize and stop crawling
              if (OPTIMIZABLE_ENTRY_RE.test(resolved)) {
                depImports[id] = resolved
              }
              return externalUnlessEntry({ path: id })
            } else {
              const namespace = htmlTypesRE.test(resolved) ? 'html' : undefined
              // linked package, keep crawling
              return {
                path: path.resolve(resolved),
                namespace
              }
            }
          } else {
            missing[id] = normalizePath(importer)
          }
        }
      )

      // Externalized file types -----------------------------------------------
      // these are done on raw ids using esbuild's native regex filter so it
      // should be faster than doing it in the catch-all via js
      // they are done after the bare import resolve because a package name
      // may end with these extensions

      // css & json
      build.onResolve(
        {
          filter: /\.(css|less|sass|scss|styl|stylus|pcss|postcss|json)$/
        },
        externalUnlessEntry
      )

      // known asset types
      build.onResolve(
        {
          filter: new RegExp(`\\.(${KNOWN_ASSET_TYPES.join('|')})$`)
        },
        externalUnlessEntry
      )

      // known vite query types: ?worker, ?raw
      build.onResolve({ filter: SPECIAL_QUERY_RE }, ({ path }) => ({
        path,
        external: true
      }))

      // catch all -------------------------------------------------------------

      build.onResolve(
        {
          filter: /.*/
        },
        async ({ path: id, importer }) => {
          // use vite resolver to support urls and omitted extensions
          console.log('all resloved --------------->', id)
          const resolved = await resolve(id, importer)
          if (resolved) {
            if (shouldExternalizeDep(resolved, id)) {
              return externalUnlessEntry({ path: id })
            }

            const namespace = htmlTypesRE.test(resolved) ? 'html' : undefined

            return {
              path: path.resolve(cleanUrl(resolved)),
              namespace
            }
          } else {
            // resolve failed... probably unsupported type
            return externalUnlessEntry({ path: id })
          }
        }
      )

      // for jsx/tsx, we need to access the content and check for
      // presence of import.meta.glob, since it results in import relationships
      // but isn't crawled by esbuild.
      build.onLoad({ filter: JS_TYPES_RE }, ({ path: id }) => {
        console.log('js load --------------->', id)
        let ext = path.extname(id).slice(1)
        if (ext === 'mjs') ext = 'js'

        let contents = fs.readFileSync(id, 'utf-8')
        if (ext.endsWith('x') && config.esbuild && config.esbuild.jsxInject) {
          contents = config.esbuild.jsxInject + `\n` + contents
        }

        if (contents.includes('import.meta.glob')) {
          return transformGlob(contents, id, config.root, ext as Loader).then(
            (contents) => ({
              loader: ext as Loader,
              contents
            })
          )
        }
        return {
          loader: ext as Loader,
          contents
        }
      })
    }
  }
}

async function transformGlob(
  source: string,
  importer: string,
  root: string,
  loader: Loader
) {
  // transform the content first since es-module-lexer can't handle non-js
  if (loader !== 'js') {
    source = (await transform(source, { loader })).code
  }

  await init
  const imports = parse(source)[0]
  const s = new MagicString(source)
  for (let index = 0; index < imports.length; index++) {
    const { s: start, e: end, ss: expStart } = imports[index]
    const url = source.slice(start, end)
    if (url !== 'import.meta') continue
    if (source.slice(end, end + 5) !== '.glob') continue
    const { importsString, exp, endIndex } = await transformImportGlob(
      source,
      start,
      normalizePath(importer),
      index,
      root
    )
    s.prepend(importsString)
    s.overwrite(expStart, endIndex, exp)
  }
  return s.toString()
}

/**
 * when using TS + (Vue + `<script setup>`) or Svelte, imports may seem
 * unused to esbuild and dropped in the build output, which prevents
 * esbuild from crawling further.
 * the solution is to add `import 'x'` for every source to force
 * esbuild to keep crawling due to potential side effects.
 */
function extractImportPaths(code: string) {
  // empty singleline & multiline comments to avoid matching comments
  code = code
    .replace(multilineCommentsRE, '/* */')
    .replace(singlelineCommentsRE, '')

  let js = ''
  let m
  while ((m = importsRE.exec(code)) != null) {
    // This is necessary to avoid infinite loops with zero-width matches
    if (m.index === importsRE.lastIndex) {
      importsRE.lastIndex++
    }
    js += `\nimport ${m[1]}`
  }
  return js
}

export function shouldExternalizeDep(
  resolvedId: string,
  rawId: string
): boolean {
  // not a valid file path
  if (!path.isAbsolute(resolvedId)) {
    return true
  }
  // virtual id
  if (resolvedId === rawId || resolvedId.includes('\0')) {
    return true
  }
  // resolved is not a scannable type
  if (!JS_TYPES_RE.test(resolvedId) && !htmlTypesRE.test(resolvedId)) {
    return true
  }
  return false
}
