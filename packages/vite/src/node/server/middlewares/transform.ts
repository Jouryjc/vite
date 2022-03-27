import path from 'path'
import type { ViteDevServer } from '..'
import type { Connect } from 'types/connect'
import {
  cleanUrl,
  createDebugger,
  injectQuery,
  isImportRequest,
  isJSRequest,
  normalizePath,
  prettifyUrl,
  removeImportQuery,
  removeTimestampQuery,
  unwrapId
} from '../../utils'
import { send } from '../send'
import { transformRequest } from '../transformRequest'
import { isHTMLProxy } from '../../plugins/html'
import colors from 'picocolors'
import {
  CLIENT_PUBLIC_PATH,
  DEP_VERSION_RE,
  NULL_BYTE_PLACEHOLDER
} from '../../constants'
import {
  isCSSRequest,
  isDirectCSSRequest,
  isDirectRequest
} from '../../plugins/css'

/**
 * Time (ms) Vite has to full-reload the page before returning
 * an empty response.
 */
const NEW_DEPENDENCY_BUILD_TIMEOUT = 1000

const debugCache = createDebugger('vite:cache')
const isDebug = !!process.env.DEBUG

const knownIgnoreList = new Set(['/', '/favicon.ico'])

/**
 * 文件转换中间件
 * @param {ViteDevServer} server http服务
 * @returns {Connect.NextHandleFunction} 中间件
 */
export function transformMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  const {
    config: { root, logger, cacheDir },
    moduleGraph
  } = server

  // 确定缓存目录中文件的 url前缀
  const cacheDirRelative = normalizePath(path.relative(root, cacheDir))
  const cacheDirPrefix = cacheDirRelative.startsWith('../')
    ? // if the cache directory is outside root, the url prefix would be something
      // like '/@fs/absolute/path/to/node_modules/.vite'
      `/@fs/${normalizePath(cacheDir).replace(/^\//, '')}`
    : // if the cache directory is inside root, the url prefix would be something
      // like '/node_modules/.vite'
      `/${cacheDirRelative}`

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return async function viteTransformMiddleware(req, res, next) {
    // 如果请求不是GET、url在忽略列表中，直接到下一个中间件
    if (req.method !== 'GET' || knownIgnoreList.has(req.url!)) {
      return next()
    }

    if (
      server._pendingReload &&
      // always allow vite client requests so that it can trigger page reload
      !req.url?.startsWith(CLIENT_PUBLIC_PATH) &&
      !req.url?.includes('vite/dist/client')
    ) {
      try {
        // missing dep pending reload, hold request until reload happens
        await Promise.race([
          server._pendingReload,
          // If the refresh has not happened after timeout, Vite considers
          // something unexpected has happened. In this case, Vite
          // returns an empty response that will error.
          // 如果超时后没有刷新，Vite 认为发生了意外情况。在这种情况下，Vite 返回一个会出错的空响应。
          new Promise((_, reject) =>
            setTimeout(reject, NEW_DEPENDENCY_BUILD_TIMEOUT)
          )
        ])
      } catch {
        // Don't do anything if response has already been sent
        if (!res.writableEnded) {
          // status code request timeout
          res.statusCode = 408
          res.end(
            `<h1>[vite] Something unexpected happened while optimizing "${req.url}"<h1>` +
              `<p>The current page should have reloaded by now</p>`
          )
        }
        return
      }
    }
    let url: string
    try {
      url = decodeURI(removeTimestampQuery(req.url!)).replace(
        NULL_BYTE_PLACEHOLDER,
        '\0'
      )
    } catch (e) {
      return next(e)
    }

    // 清除url中的hash值和query参数
    const withoutQuery = cleanUrl(url)

    try {
      // sourcemap 的处理
      const isSourceMap = withoutQuery.endsWith('.map')
      // since we generate source map references, handle those requests here
      if (isSourceMap) {
        const originalUrl = url.replace(/\.map($|\?)/, '$1')
        const map = (await moduleGraph.getModuleByUrl(originalUrl, false))
          ?.transformResult?.map
        if (map) {
          return send(req, res, JSON.stringify(map), 'json', {
            headers: server.config.server.headers
          })
        } else {
          return next()
        }
      }

      // check if public dir is inside root dir
      const publicDir = normalizePath(server.config.publicDir)
      const rootDir = normalizePath(server.config.root)
      if (publicDir.startsWith(rootDir)) {
        const publicPath = `${publicDir.slice(rootDir.length)}/`
        // warn explicit public paths
        if (url.startsWith(publicPath)) {
          logger.warn(
            colors.yellow(
              `files in the public directory are served at the root path.\n` +
                `Instead of ${colors.cyan(url)}, use ${colors.cyan(
                  url.replace(publicPath, '/')
                )}.`
            )
          )
        }
      }

      // 如果是js、import查询、css、html-proxy
      if (
        isJSRequest(url) ||
        isImportRequest(url) ||
        isCSSRequest(url) ||
        isHTMLProxy(url)
      ) {
        // strip ?import
        url = removeImportQuery(url)
        // Strip valid id prefix. This is prepended to resolved Ids that are
        // not valid browser import specifiers by the importAnalysis plugin.
        url = unwrapId(url)

        // for CSS, we need to differentiate between normal CSS requests and
        // imports
        if (
          isCSSRequest(url) &&
          !isDirectRequest(url) &&
          req.headers.accept?.includes('text/css')
        ) {
          url = injectQuery(url, 'direct')
        }

        // check if we can return 304 early
        const ifNoneMatch = req.headers['if-none-match']
        if (
          ifNoneMatch &&
          (await moduleGraph.getModuleByUrl(url, false))?.transformResult
            ?.etag === ifNoneMatch
        ) {
          isDebug && debugCache(`[304] ${prettifyUrl(url, root)}`)
          res.statusCode = 304
          return res.end()
        }

        // 使用插件容器解析、接在和转换
        const result = await transformRequest(url, server, {
          html: req.headers.accept?.includes('text/html')
        })
        if (result) {
          const type = isDirectCSSRequest(url) ? 'css' : 'js'
          const isDep =
            DEP_VERSION_RE.test(url) ||
            (cacheDirPrefix && url.startsWith(cacheDirPrefix))

          return send(req, res, result.code, type, {
            etag: result.etag,
            // allow browser to cache npm deps!
            cacheControl: isDep ? 'max-age=31536000,immutable' : 'no-cache',
            headers: server.config.server.headers,
            map: result.map
          })
        }
      }
    } catch (e) {
      return next(e)
    }

    next()
  }
}
