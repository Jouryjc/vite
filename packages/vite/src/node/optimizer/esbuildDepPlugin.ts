import path from 'path'
import type { Loader, Plugin, ImportKind } from 'esbuild'
import { KNOWN_ASSET_TYPES } from '../constants'
import type { ResolvedConfig } from '..'
import {
  isRunningWithYarnPnp,
  flattenId,
  normalizePath,
  isExternalUrl,
  moduleListContains
} from '../utils'
import { browserExternalId } from '../plugins/resolve'
import type { ExportsData } from '.'

const externalTypes = [
  'css',
  // supported pre-processor types
  'less',
  'sass',
  'scss',
  'styl',
  'stylus',
  'pcss',
  'postcss',
  // known SFC types
  'vue',
  'svelte',
  'marko',
  'astro',
  // JSX/TSX may be configured to be compiled differently from how esbuild
  // handles it by default, so exclude them as well
  'jsx',
  'tsx',
  ...KNOWN_ASSET_TYPES
]

export function esbuildDepPlugin(
  qualified: Record<string, string>,
  exportsData: Record<string, ExportsData>,
  config: ResolvedConfig,
  ssr?: boolean
): Plugin {
  // 默认 esm 默认解析器
  const _resolve = config.createResolver({ asSrc: false })

  // node 的 cjs 解析器
  const _resolveRequire = config.createResolver({
    asSrc: false,
    isRequire: true
  })

  const resolve = (
    id: string,
    importer: string,
    kind: ImportKind,
    resolveDir?: string
  ): Promise<string | undefined> => {
    let _importer: string
    // explicit resolveDir - this is passed only during yarn pnp resolve for
    // entries
    if (resolveDir) {
      _importer = normalizePath(path.join(resolveDir, '*'))
    } else {
      // map importer ids to file paths for correct resolution
      _importer = importer in qualified ? qualified[importer] : importer
    }
    // kind 是 esbuild resolve 回调中的一个参数，表示模块类型，总共有 7 种类型
    // https://esbuild.github.io/plugins/#on-resolve-arguments
    // 以require开头的表示cjs、否则用esm的解析器
    const resolver = kind.startsWith('require') ? _resolveRequire : _resolve
    return resolver(id, _importer, undefined, ssr)
  }

  return {
    name: 'vite:dep-pre-bundle',
    setup(build) {
      console.log('dep-pre-bundle -------->, ', build.initialOptions)
      // 将全部非js的资源 external（排除，外部化）
      build.onResolve(
        {
          filter: new RegExp(`\\.(` + externalTypes.join('|') + `)(\\?.*)?$`)
        },
        async ({ path: id, importer, kind }) => {
          const resolved = await resolve(id, importer, kind)
          if (resolved) {
            return {
              path: resolved,
              external: true
            }
          }
        }
      )

      /**
       * 解析入口
       *
       * @param {string} id
       * @return {*} 
       */
      function resolveEntry(id: string) {
        const flatId = flattenId(id)
        if (flatId in qualified) {
          return {
            path: flatId,
            namespace: 'dep'
          }
        }
      }

      build.onResolve(
        { filter: /^[\w@][^:]/ },
        async ({ path: id, importer, kind }) => {
          // 排除 config.optimizeDeps?.exclude，同样通过 external 排除
          if (moduleListContains(config.optimizeDeps?.exclude, id)) {
            return {
              path: id,
              external: true
            }
          }

          // ensure esbuild uses our resolved entries
          let entry: { path: string; namespace: string } | undefined
          // if this is an entry, return entry namespace resolve result
          if (!importer) {
            if ((entry = resolveEntry(id))) return entry
            // check if this is aliased to an entry - also return entry namespace
            const aliased = await _resolve(id, undefined, true)
            if (aliased && (entry = resolveEntry(aliased))) {
              return entry
            }
          }

          // use vite's own resolver
          const resolved = await resolve(id, importer, kind)
          if (resolved) {
            if (resolved.startsWith(browserExternalId)) {
              return {
                path: id,
                namespace: 'browser-external'
              }
            }
            if (isExternalUrl(resolved)) {
              return {
                path: resolved,
                external: true
              }
            }
            return {
              path: path.resolve(resolved)
            }
          }
        }
      )

      // For entry files, we'll read it ourselves and construct a proxy module
      // to retain the entry's raw id instead of file path so that esbuild
      // outputs desired output file structure.
      // It is necessary to do the re-exporting to separate the virtual proxy
      // module from the actual module since the actual module may get
      // referenced via relative imports - if we don't separate the proxy and
      // the actual module, esbuild will create duplicated copies of the same
      // module!
      const root = path.resolve(config.root)
      build.onLoad({ filter: /.*/, namespace: 'dep' }, ({ path: id }) => {
        console.log('dep load --------->', id)
        const entryFile = qualified[id]

        // 相对根目录的路径
        let relativePath = normalizePath(path.relative(root, entryFile))
        // 自动加上路径前缀
        if (
          !relativePath.startsWith('./') &&
          !relativePath.startsWith('../') &&
          relativePath !== '.'
        ) {
          relativePath = `./${relativePath}`
        }

        let contents = ''
        // 获取文件的 import、export 信息
        const data = exportsData[id]
        const [imports, exports] = data
        if (!imports.length && !exports.length) {
          // cjs
          contents += `export default require("${relativePath}");`
        } else {
          if (exports.includes('default')) {
            contents += `import d from "${relativePath}";export default d;`
          }
          if (
            data.hasReExports ||
            exports.length > 1 ||
            exports[0] !== 'default'
          ) {
            contents += `\nexport * from "${relativePath}"`
          }
        }

        let ext = path.extname(entryFile).slice(1)
        if (ext === 'mjs') ext = 'js'
        return {
          loader: ext as Loader,
          contents,
          resolveDir: root
        }
      })

      build.onLoad(
        { filter: /.*/, namespace: 'browser-external' },
        ({ path: id }) => {
          return {
            contents:
              `export default new Proxy({}, {
  get() {
    throw new Error('Module "${id}" has been externalized for ` +
              `browser compatibility and cannot be accessed in client code.')
  }
})`
          }
        }
      )

      // yarn 2 pnp compat
      if (isRunningWithYarnPnp) {
        build.onResolve(
          { filter: /.*/ },
          async ({ path, importer, kind, resolveDir }) => ({
            // pass along resolveDir for entries
            path: await resolve(path, importer, kind, resolveDir)
          })
        )
        build.onLoad({ filter: /.*/ }, async (args) => ({
          contents: await require('fs').promises.readFile(args.path),
          loader: 'default'
        }))
      }
    }
  }
}
