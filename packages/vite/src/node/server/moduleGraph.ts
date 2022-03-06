import { extname } from 'path'
import type { ModuleInfo, PartialResolvedId } from 'rollup'
import { parse as parseUrl } from 'url'
import { isDirectCSSRequest } from '../plugins/css'
import {
  cleanUrl,
  normalizePath,
  removeImportQuery,
  removeTimestampQuery
} from '../utils'
import { FS_PREFIX } from '../constants'
import type { TransformResult } from './transformRequest'

/**
 * 每一个模块节点的信息
 */
export class ModuleNode {
  /**
   * Public served url path, starts with /
   */
  url: string
  /**
   * Resolved file system path + query
   */
  id: string | null = null
  file: string | null = null
  type: 'js' | 'css'
  info?: ModuleInfo
  meta?: Record<string, any>
  importers = new Set<ModuleNode>()
  importedModules = new Set<ModuleNode>()
  acceptedHmrDeps = new Set<ModuleNode>()
  isSelfAccepting = false
  transformResult: TransformResult | null = null
  ssrTransformResult: TransformResult | null = null
  ssrModule: Record<string, any> | null = null
  lastHMRTimestamp = 0

  constructor(url: string) {
    this.url = url
    this.type = isDirectCSSRequest(url) ? 'css' : 'js'
  }
}

function invalidateSSRModule(mod: ModuleNode, seen: Set<ModuleNode>) {
  if (seen.has(mod)) {
    return
  }
  seen.add(mod)
  mod.ssrModule = null
  mod.importers.forEach((importer) => invalidateSSRModule(importer, seen))
}

export type ResolvedUrl = [
  url: string,
  resolvedId: string,
  meta: object | null | undefined
]

export class ModuleGraph {
  // url 和模块的映射
  urlToModuleMap = new Map<string, ModuleNode>()
  // id 和模块的映射
  idToModuleMap = new Map<string, ModuleNode>()
  // 文件和模块的映射，一个文件对应多个模块，比如 SFC 就对应多个模块
  fileToModulesMap = new Map<string, Set<ModuleNode>>()
  // /@fs 的模块
  safeModulesPath = new Set<string>()

  constructor(
    // 内部的 resolvceId 是通过构造函数传进来的
    private resolveId: (
      url: string,
      ssr: boolean
    ) => Promise<PartialResolvedId | null>
  ) {}

  /**
   * 通过url获取模块
   */
  async getModuleByUrl(
    rawUrl: string,
    ssr?: boolean
  ): Promise<ModuleNode | undefined> {
    const [url] = await this.resolveUrl(rawUrl, ssr)
    return this.urlToModuleMap.get(url)
  }

  /**
   * 通过 id 获取模块
   */
  getModuleById(id: string): ModuleNode | undefined {
    return this.idToModuleMap.get(removeTimestampQuery(id))
  }

  /**
   * 通过文件获取模块
   */
  getModulesByFile(file: string): Set<ModuleNode> | undefined {
    return this.fileToModulesMap.get(file)
  }

  /**
   * 文件修改的事件
   */
  onFileChange(file: string): void {
    const mods = this.getModulesByFile(file)
    if (mods) {
      const seen = new Set<ModuleNode>()
      mods.forEach((mod) => {
        this.invalidateModule(mod, seen)
      })
    }
  }

  /**
   * 处理失效的模块
   */
  invalidateModule(mod: ModuleNode, seen: Set<ModuleNode> = new Set()): void {
    mod.info = undefined
    mod.transformResult = null
    mod.ssrTransformResult = null
    invalidateSSRModule(mod, seen)
  }

  /**
   * 删除全部失效模块
   */
  invalidateAll(): void {
    const seen = new Set<ModuleNode>()
    this.idToModuleMap.forEach((mod) => {
      this.invalidateModule(mod, seen)
    })
  }

  /**
   * Update the module graph based on a module's updated imports information
   * If there are dependencies that no longer have any importers, they are
   * returned as a Set.
   *
   * 更新模块依赖信息
   * @param {ModuleNode} mod 指定模块A
   * @param {Set<string | ModuleNode>} importedModules 模块 A 引入的模块
   * @param {Set<string | ModuleNode>} acceptedModules 模块 A 热更的模块
   * @param {boolean} isSelfAccepting 自身是否有 accpet 函数
   * @param {boolean} ssr
   */
  async updateModuleInfo(
    mod: ModuleNode,
    importedModules: Set<string | ModuleNode>,
    acceptedModules: Set<string | ModuleNode>,
    isSelfAccepting: boolean,
    ssr?: boolean
  ): Promise<Set<ModuleNode> | undefined> {
    mod.isSelfAccepting = isSelfAccepting
    // 前置依赖
    const prevImports = mod.importedModules
    // 后置依赖
    const nextImports = (mod.importedModules = new Set())
    let noLongerImported: Set<ModuleNode> | undefined
    // update import graph
    // 更新引入模块
    for (const imported of importedModules) {
      const dep =
        typeof imported === 'string'
          ? await this.ensureEntryFromUrl(imported, ssr)
          : imported
      dep.importers.add(mod)
      nextImports.add(dep)
    }
    // remove the importer from deps that were imported but no longer are.
    // 从依赖的 importer 中删除不再使用的 import
    prevImports.forEach((dep) => {
      if (!nextImports.has(dep)) {
        dep.importers.delete(mod)
        if (!dep.importers.size) {
          // dependency no longer imported
          ;(noLongerImported || (noLongerImported = new Set())).add(dep)
        }
      }
    })
    // update accepted hmr deps
    // 更新 accepted 的依赖
    const deps = (mod.acceptedHmrDeps = new Set())
    for (const accepted of acceptedModules) {
      const dep =
        typeof accepted === 'string'
          ? await this.ensureEntryFromUrl(accepted, ssr)
          : accepted
      deps.add(dep)
    }
    return noLongerImported
  }

  /**
   * 根据 url 生成模块
   */
  async ensureEntryFromUrl(rawUrl: string, ssr?: boolean): Promise<ModuleNode> {
    const [url, resolvedId, meta] = await this.resolveUrl(rawUrl, ssr)
    // 根据 url 获取模块
    let mod = this.urlToModuleMap.get(url)
    if (!mod) {
      // 实例化一个模块节点
      mod = new ModuleNode(url)
      // 设置模块节点元信息
      if (meta) mod.meta = meta
      // 存入 url 跟模块的 map 中
      this.urlToModuleMap.set(url, mod)
      // id 就是 import 进来的路径
      mod.id = resolvedId
      // 存入 id 跟模块的 map 中
      this.idToModuleMap.set(resolvedId, mod)
      // 设置节点的 file 信息
      const file = (mod.file = cleanUrl(resolvedId))
      // 处理 file 跟模块的关系
      let fileMappedModules = this.fileToModulesMap.get(file)
      if (!fileMappedModules) {
        fileMappedModules = new Set()
        this.fileToModulesMap.set(file, fileMappedModules)
      }
      fileMappedModules.add(mod)
    }
    return mod
  }

  /**
   * some deps, like a css file referenced via @import, don't have its own
   * url because they are inlined into the main css import. But they still
   * need to be represented in the module graph so that they can trigger
   * hmr in the importing css file.
   *
   * 根据引入生成 import，比如 css 常用的 import，在 css 代码里面，没有 url
   * 但是这种也属于模块图中需要识别的内容
   */
  createFileOnlyEntry(file: string): ModuleNode {
    file = normalizePath(file)
    let fileMappedModules = this.fileToModulesMap.get(file)
    if (!fileMappedModules) {
      fileMappedModules = new Set()
      this.fileToModulesMap.set(file, fileMappedModules)
    }

    const url = `${FS_PREFIX}${file}`
    for (const m of fileMappedModules) {
      if (m.url === url || m.id === file) {
        return m
      }
    }

    const mod = new ModuleNode(url)
    mod.file = file
    fileMappedModules.add(mod)
    return mod
  }

  /**
   * 解析url，做两件事：
   * 1. 移除 HMR 的时间戳
   * 2. 处理文件后缀，保证文件名一致时（后缀即使不一样）也能够映射到同一个模块
   */
  async resolveUrl(url: string, ssr?: boolean): Promise<ResolvedUrl> {
    url = removeImportQuery(removeTimestampQuery(url))
    const resolved = await this.resolveId(url, !!ssr)
    const resolvedId = resolved?.id || url
    const ext = extname(cleanUrl(resolvedId))
    const { pathname, search, hash } = parseUrl(url)
    if (ext && !pathname!.endsWith(ext)) {
      url = pathname + ext + (search || '') + (hash || '')
    }
    return [url, resolvedId, resolved?.meta]
  }
}
