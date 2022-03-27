import { promises as fs } from 'fs'
import path from 'path'
import getEtag from 'etag'
import * as convertSourceMap from 'convert-source-map'
import type { SourceDescription, SourceMap } from 'rollup'
import type { ViteDevServer } from '..'
import colors from 'picocolors'
import {
  createDebugger,
  cleanUrl,
  prettifyUrl,
  removeTimestampQuery,
  timeFrom,
  ensureWatchedFile,
  isObject
} from '../utils'
import { checkPublicFile } from '../plugins/asset'
import { ssrTransform } from '../ssr/ssrTransform'
import { injectSourcesContent } from './sourcemap'
import { isFileServingAllowed } from './middlewares/static'
import { performance } from 'perf_hooks'

const debugLoad = createDebugger('vite:load')
const debugTransform = createDebugger('vite:transform')
const debugCache = createDebugger('vite:cache')
const isDebug = !!process.env.DEBUG

export interface TransformResult {
  code: string
  map: SourceMap | null
  etag?: string
  deps?: string[]
  dynamicDeps?: string[]
}

export interface TransformOptions {
  ssr?: boolean
  html?: boolean
}

export function transformRequest(
  url: string,
  server: ViteDevServer,
  options: TransformOptions = {}
): Promise<TransformResult | null> {
  // 缓存key值定义，如果是ssr，就加 ssr: 前缀，如果是 html 就加 html: 前缀
  const cacheKey = (options.ssr ? 'ssr:' : options.html ? 'html:' : '') + url
  // 判断请求队列中是否存在当前的请求
  let request = server._pendingRequests.get(cacheKey)
  // 如果不存在
  if (!request) {
    // 重点：获取url对应的模块并解析、转换
    request = doTransform(url, server, options)
    // 将url对应的请求加到
    server._pendingRequests.set(cacheKey, request)
    // 请求完成后将对应的请求从_pendingRequests删除
    const done = () => server._pendingRequests.delete(cacheKey)
    request.then(done, done)
  }
  return request
}

/**
 * 解析转换
 * @param {string} url 请求进来的路径
 * @param {ViteDevServer} server http服务
 * @param {TransformOptions} options 转换配置，{ html: false }
 *
 */
async function doTransform(
  url: string,
  server: ViteDevServer,
  options: TransformOptions
) {
  // 移除时间戳的查询参数
  url = removeTimestampQuery(url)
  const { config, pluginContainer, moduleGraph, watcher } = server
  const { root, logger } = config
  const prettyUrl = isDebug ? prettifyUrl(url, root) : ''
  const ssr = !!options.ssr

  // 根据 url 获取模块
  const module = await server.moduleGraph.getModuleByUrl(url, ssr)

  // dev 下缓存解析转换后的结果
  const cached =
    module && (ssr ? module.ssrTransformResult : module.transformResult)
  if (cached) {
    // TODO: check if the module is "partially invalidated" - i.e. an import
    // down the chain has been fully invalidated, but this current module's
    // content has not changed.
    // in this case, we can reuse its previous cached result and only update
    // its import timestamps.

    isDebug && debugCache(`[memory] ${prettyUrl}`)
    return cached
  }

  // 拿到模块对应的绝对路径 /Users/yjcjour/Documents/code/vite/examples/vite-learning/main.js
  const id =
    (await pluginContainer.resolveId(url, undefined, { ssr }))?.id || url

  // 净化id，去除hash和query参数
  const file = cleanUrl(id)

  let code: string | null = null
  let map: SourceDescription['map'] = null

  // load
  const loadStart = isDebug ? performance.now() : 0
  // 执行插件的 load 钩子
  const loadResult = await pluginContainer.load(id, { ssr })
  if (loadResult == null) {
    // if this is an html request and there is no load result, skip ahead to
    // SPA fallback.
    if (options.html && !id.endsWith('.html')) {
      return null
    }
    // try fallback loading it from fs as string
    // if the file is a binary, there should be a plugin that already loaded it
    // as string
    // only try the fallback if access is allowed, skip for out of root url
    // like /service-worker.js or /api/users
    if (options.ssr || isFileServingAllowed(file, server)) {
      try {
        code = await fs.readFile(file, 'utf-8')
        isDebug && debugLoad(`${timeFrom(loadStart)} [fs] ${prettyUrl}`)
      } catch (e) {
        if (e.code !== 'ENOENT') {
          throw e
        }
      }
    }
    if (code) {
      try {
        map = (
          convertSourceMap.fromSource(code) ||
          convertSourceMap.fromMapFileSource(code, path.dirname(file))
        )?.toObject()
      } catch (e) {
        logger.warn(`Failed to load source map for ${url}.`, {
          timestamp: true
        })
      }
    }
  } else {
    isDebug && debugLoad(`${timeFrom(loadStart)} [plugin] ${prettyUrl}`)
    if (isObject(loadResult)) {
      code = loadResult.code
      map = loadResult.map
    } else {
      code = loadResult
    }
  }
  if (code == null) {
    if (checkPublicFile(url, config)) {
      throw new Error(
        `Failed to load url ${url} (resolved id: ${id}). ` +
          `This file is in /public and will be copied as-is during build without ` +
          `going through the plugin transforms, and therefore should not be ` +
          `imported from source code. It can only be referenced via HTML tags.`
      )
    } else {
      return null
    }
  }

  // ensure module in graph after successful load
  // 确保模块在模块图中正常加载
  const mod = await moduleGraph.ensureEntryFromUrl(url, ssr)
  // 确保模块文件被文件监听器监听
  ensureWatchedFile(watcher, mod.file, root)

  // transform
  const transformStart = isDebug ? performance.now() : 0

  // 核心核心核心！调用转换钩子
  const transformResult = await pluginContainer.transform(code, id, {
    inMap: map,
    ssr
  })
  if (
    transformResult == null ||
    (isObject(transformResult) && transformResult.code == null)
  ) {
    // no transform applied, keep code as-is
    isDebug &&
      debugTransform(
        timeFrom(transformStart) + colors.dim(` [skipped] ${prettyUrl}`)
      )
  } else {
    isDebug && debugTransform(`${timeFrom(transformStart)} ${prettyUrl}`)
    code = transformResult.code!
    map = transformResult.map
  }

  if (map && mod.file) {
    map = (typeof map === 'string' ? JSON.parse(map) : map) as SourceMap
    if (map.mappings && !map.sourcesContent) {
      await injectSourcesContent(map, mod.file, logger)
    }
  }

  if (ssr) {
    return (mod.ssrTransformResult = await ssrTransform(
      code,
      map as SourceMap,
      url
    ))
  } else {
    // 将当前转换后的 code 和 sourcemap 都存到模块的 transformResult 属性上，并根据 code 生成 etag
    return (mod.transformResult = {
      code,
      map,
      etag: getEtag(code, { weak: true })
    } as TransformResult)
  }
}
