import fs from 'node:fs'
import path from 'node:path'
import type { FSWatcher } from 'dep-types/chokidar'
import type { ResolvedConfig } from './config'
import {
  createDebugger,
  isInNodeModules,
  normalizePath,
  safeRealpathSync,
  tryStatSync,
} from './utils'
import { searchForWorkspaceRoot } from './server/searchRoot'

const debug = createDebugger('vite:fs')

export interface FsUtils {
  existsSync: (path: string) => boolean
  isDirectory: (path: string) => boolean

  tryResolveRealFile: (
    path: string,
    preserveSymlinks?: boolean,
  ) => string | undefined
  tryResolveRealFileWithExtensions: (
    path: string,
    extensions: string[],
    preserveSymlinks?: boolean,
  ) => string | undefined
  tryResolveRealFileOrType: (
    path: string,
    preserveSymlinks?: boolean,
  ) => { path?: string; type: 'directory' | 'file' } | undefined

  initWatcher?: (watcher: FSWatcher) => void
}

// An implementation of fsUtils without caching
export const commonFsUtils: FsUtils = {
  existsSync: fs.existsSync,
  isDirectory,

  tryResolveRealFile,
  tryResolveRealFileWithExtensions,
  tryResolveRealFileOrType,
}

const activeResolvedConfigs = new Array<WeakRef<ResolvedConfig>>()
const registry = new FinalizationRegistry((fsUtils: FsUtils) => {
  const i = activeResolvedConfigs.findIndex((r) => !r.deref())
  activeResolvedConfigs.splice(i, 1)
})
function addActiveResolvedConfig(config: ResolvedConfig, fsUtils: FsUtils) {
  activeResolvedConfigs.push(new WeakRef(config))
  registry.register(config, fsUtils)
  debug?.(
    `registered FsUtils for config with root ${config.root}, active configs: ${activeResolvedConfigs.length}`,
  )
}

const cachedFsUtilsMap = new WeakMap<ResolvedConfig, FsUtils>()
export function getFsUtils(config: ResolvedConfig): FsUtils {
  let fsUtils = cachedFsUtilsMap.get(config)
  if (!fsUtils) {
    debug?.(`resolving FsUtils for ${config.root}`)
    if (config.command !== 'serve' || !config.server.fs.cachedChecks) {
      // cached fsUtils is only used in the dev server for now, and only when the watcher isn't configured
      // we can support custom ignored patterns later
      fsUtils = commonFsUtils
    } else if (
      !config.resolve.preserveSymlinks &&
      config.root !== getRealPath(config.root)
    ) {
      fsUtils = commonFsUtils
    } else {
      fsUtils = createCachedFsUtils(config)
      addActiveResolvedConfig(config, fsUtils)
    }
    cachedFsUtilsMap.set(config, fsUtils)
  }
  return fsUtils
}

type DirentsMap = Map<string, DirentCache>

type DirentCacheType =
  | 'directory'
  | 'file'
  | 'symlink'
  | 'error'
  | 'directory_maybe_symlink'
  | 'file_maybe_symlink'

interface DirentCache {
  dirents?: DirentsMap
  type: DirentCacheType
}

function readDirCacheSync(file: string): undefined | DirentsMap {
  let dirents: fs.Dirent[]
  try {
    dirents = fs.readdirSync(file, { withFileTypes: true })
  } catch {
    return
  }
  return direntsToDirentMap(dirents)
}

function direntsToDirentMap(fsDirents: fs.Dirent[]): DirentsMap {
  const dirents: DirentsMap = new Map()
  for (const dirent of fsDirents) {
    // We ignore non directory, file, and symlink entries
    const type = dirent.isDirectory()
      ? 'directory'
      : dirent.isSymbolicLink()
        ? 'symlink'
        : dirent.isFile()
          ? 'file'
          : undefined
    if (type) {
      dirents.set(dirent.name, { type })
    }
  }
  return dirents
}

function ensureFileMaybeSymlinkIsResolved(
  direntCache: DirentCache,
  filePath: string,
) {
  if (direntCache.type !== 'file_maybe_symlink') return

  const isSymlink = fs
    .lstatSync(filePath, { throwIfNoEntry: false })
    ?.isSymbolicLink()
  direntCache.type =
    isSymlink === undefined ? 'error' : isSymlink ? 'symlink' : 'file'
}

interface CachedFsUtilsMeta {
  root: string
  rootCache: DirentCache
}
const cachedFsUtilsMeta = new WeakMap<ResolvedConfig, CachedFsUtilsMeta>()

function createSharedRootCache(root: string): DirentCache {
  for (const otherConfigRef of activeResolvedConfigs) {
    const otherConfig = otherConfigRef?.deref()
    if (otherConfig) {
      const otherCachedFsUtilsMeta = cachedFsUtilsMeta.get(otherConfig)!
      const { rootCache: otherRootCache, root: otherRoot } =
        otherCachedFsUtilsMeta
      if (root === otherRoot) {
        debug?.(`FsUtils for ${root} sharing root cache with compatible cache`)
        return otherRootCache
      }
    }
  }

  debug?.(`FsUtils for ${root} started as an new root cache`)
  return { type: 'directory' as DirentCacheType } // dirents will be computed lazily
}

function pathUntilPart(root: string, parts: string[], i: number): string {
  let p = root
  for (let k = 0; k < i; k++) p += '/' + parts[k]
  return p
}

function createCachedFsUtils(config: ResolvedConfig): FsUtils {
  const root = normalizePath(searchForWorkspaceRoot(config.root))
  const rootDirPath = `${root}/`
  const rootCache = createSharedRootCache(root)
  cachedFsUtilsMeta.set(config, { root, rootCache })

  const getDirentCacheSync = (parts: string[]): DirentCache | undefined => {
    let direntCache: DirentCache = rootCache
    for (let i = 0; i < parts.length; i++) {
      if (direntCache.type === 'directory') {
        let dirPath
        if (!direntCache.dirents) {
          dirPath = pathUntilPart(root, parts, i)
          const dirents = readDirCacheSync(dirPath)
          if (!dirents) {
            direntCache.type = 'error'
            return
          }
          direntCache.dirents = dirents
        }
        const nextDirentCache = direntCache.dirents!.get(parts[i])
        if (!nextDirentCache) {
          return
        }
        if (nextDirentCache.type === 'directory_maybe_symlink') {
          dirPath ??= pathUntilPart(root, parts, i)
          const isSymlink = fs
            .lstatSync(dirPath, { throwIfNoEntry: false })
            ?.isSymbolicLink()
          direntCache.type = isSymlink ? 'symlink' : 'directory'
        }
        direntCache = nextDirentCache
      } else if (direntCache.type === 'symlink') {
        // early return if we encounter a symlink
        return direntCache
      } else if (direntCache.type === 'error') {
        return direntCache
      } else {
        if (i !== parts.length - 1) {
          return
        }
        if (direntCache.type === 'file_maybe_symlink') {
          ensureFileMaybeSymlinkIsResolved(
            direntCache,
            pathUntilPart(root, parts, i),
          )
          return direntCache
        } else if (direntCache.type === 'file') {
          return direntCache
        } else {
          return
        }
      }
    }
    return direntCache
  }

  function getDirentCacheFromPath(
    normalizedFile: string,
  ): DirentCache | false | undefined {
    if (normalizedFile === root) {
      return rootCache
    }
    if (!normalizedFile.startsWith(rootDirPath)) {
      return undefined
    }
    const pathFromRoot = normalizedFile.slice(rootDirPath.length)
    const parts = pathFromRoot.split('/')
    const direntCache = getDirentCacheSync(parts)
    if (!direntCache || direntCache.type === 'error') {
      return false
    }
    return direntCache
  }

  function onPathAdd(
    file: string,
    type: 'directory_maybe_symlink' | 'file_maybe_symlink',
  ) {
    const direntCache = getDirentCacheFromPath(
      normalizePath(path.dirname(file)),
    )
    if (
      direntCache &&
      direntCache.type === 'directory' &&
      direntCache.dirents
    ) {
      direntCache.dirents.set(path.basename(file), { type })
    }
  }

  function onPathUnlink(file: string) {
    const direntCache = getDirentCacheFromPath(
      normalizePath(path.dirname(file)),
    )
    if (
      direntCache &&
      direntCache.type === 'directory' &&
      direntCache.dirents
    ) {
      direntCache.dirents.delete(path.basename(file))
    }
  }

  return {
    existsSync(file: string) {
      if (isInNodeModules(file)) {
        return fs.existsSync(file)
      }
      const normalizedFile = normalizePath(file)
      const direntCache = getDirentCacheFromPath(normalizedFile)
      if (
        direntCache === undefined ||
        (direntCache && direntCache.type === 'symlink')
      ) {
        // fallback to built-in fs for out-of-root and symlinked files
        return fs.existsSync(file)
      }
      return !!direntCache
    },
    tryResolveRealFile(
      file: string,
      preserveSymlinks?: boolean,
    ): string | undefined {
      if (isInNodeModules(file)) {
        return tryResolveRealFile(file, preserveSymlinks)
      }
      const normalizedFile = normalizePath(file)
      const direntCache = getDirentCacheFromPath(normalizedFile)
      if (
        direntCache === undefined ||
        (direntCache && direntCache.type === 'symlink')
      ) {
        // fallback to built-in fs for out-of-root and symlinked files
        return tryResolveRealFile(file, preserveSymlinks)
      }
      if (!direntCache || direntCache.type === 'directory') {
        return
      }
      // We can avoid getRealPath even if preserveSymlinks is false because we know it's
      // a file without symlinks in its path
      return normalizedFile
    },
    tryResolveRealFileWithExtensions(
      file: string,
      extensions: string[],
      preserveSymlinks?: boolean,
    ): string | undefined {
      if (isInNodeModules(file)) {
        return tryResolveRealFileWithExtensions(
          file,
          extensions,
          preserveSymlinks,
        )
      }
      const normalizedFile = normalizePath(file)
      const dirPath = path.posix.dirname(normalizedFile)
      const direntCache = getDirentCacheFromPath(dirPath)
      if (
        direntCache === undefined ||
        (direntCache && direntCache.type === 'symlink')
      ) {
        // fallback to built-in fs for out-of-root and symlinked files
        return tryResolveRealFileWithExtensions(
          file,
          extensions,
          preserveSymlinks,
        )
      }
      if (!direntCache || direntCache.type !== 'directory') {
        return
      }

      if (!direntCache.dirents) {
        const dirents = readDirCacheSync(dirPath)
        if (!dirents) {
          direntCache.type = 'error'
          return
        }
        direntCache.dirents = dirents
      }

      const base = path.posix.basename(normalizedFile)
      for (const ext of extensions) {
        const fileName = base + ext
        const fileDirentCache = direntCache.dirents.get(fileName)
        if (fileDirentCache) {
          const filePath = dirPath + '/' + fileName
          ensureFileMaybeSymlinkIsResolved(fileDirentCache, filePath)
          if (fileDirentCache.type === 'symlink') {
            // fallback to built-in fs for symlinked files
            return tryResolveRealFile(filePath, preserveSymlinks)
          }
          if (fileDirentCache.type === 'file') {
            return filePath
          }
        }
      }
    },
    tryResolveRealFileOrType(
      file: string,
      preserveSymlinks?: boolean,
    ): { path?: string; type: 'directory' | 'file' } | undefined {
      if (isInNodeModules(file)) {
        return tryResolveRealFileOrType(file, preserveSymlinks)
      }
      const normalizedFile = normalizePath(file)
      const direntCache = getDirentCacheFromPath(normalizedFile)
      if (
        direntCache === undefined ||
        (direntCache && direntCache.type === 'symlink')
      ) {
        // fallback to built-in fs for out-of-root and symlinked files
        return tryResolveRealFileOrType(file, preserveSymlinks)
      }
      if (!direntCache) {
        return
      }
      if (direntCache.type === 'directory') {
        return { type: 'directory' }
      }
      // We can avoid getRealPath even if preserveSymlinks is false because we know it's
      // a file without symlinks in its path
      return { path: normalizedFile, type: 'file' }
    },
    isDirectory(dirPath: string) {
      if (isInNodeModules(dirPath)) {
        return isDirectory(dirPath)
      }
      const direntCache = getDirentCacheFromPath(normalizePath(dirPath))
      if (
        direntCache === undefined ||
        (direntCache && direntCache.type === 'symlink')
      ) {
        // fallback to built-in fs for out-of-root and symlinked files
        return isDirectory(dirPath)
      }
      return direntCache && direntCache.type === 'directory'
    },

    initWatcher(watcher: FSWatcher) {
      watcher.on('add', (file) => {
        onPathAdd(file, 'file_maybe_symlink')
      })
      watcher.on('addDir', (dir) => {
        onPathAdd(dir, 'directory_maybe_symlink')
      })
      watcher.on('unlink', onPathUnlink)
      watcher.on('unlinkDir', onPathUnlink)
    },
  }
}

function tryResolveRealFile(
  file: string,
  preserveSymlinks?: boolean,
): string | undefined {
  const stat = tryStatSync(file)
  if (stat?.isFile()) return getRealPath(file, preserveSymlinks)
}

function tryResolveRealFileWithExtensions(
  filePath: string,
  extensions: string[],
  preserveSymlinks?: boolean,
): string | undefined {
  for (const ext of extensions) {
    const res = tryResolveRealFile(filePath + ext, preserveSymlinks)
    if (res) return res
  }
}

function tryResolveRealFileOrType(
  file: string,
  preserveSymlinks?: boolean,
): { path?: string; type: 'directory' | 'file' } | undefined {
  const fileStat = tryStatSync(file)
  if (fileStat?.isFile()) {
    return { path: getRealPath(file, preserveSymlinks), type: 'file' }
  }
  if (fileStat?.isDirectory()) {
    return { type: 'directory' }
  }
  return
}

function getRealPath(resolved: string, preserveSymlinks?: boolean): string {
  if (!preserveSymlinks) {
    resolved = safeRealpathSync(resolved)
  }
  return normalizePath(resolved)
}

function isDirectory(path: string): boolean {
  const stat = tryStatSync(path)
  return stat?.isDirectory() ?? false
}