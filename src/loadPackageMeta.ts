import logger from '@pnpm/logger'
import {PackageManifest} from '@pnpm/types'
import getRegistryName = require('encode-registry')
import loadJsonFile = require('load-json-file')
import pLimit = require('p-limit')
import path = require('path')
import url = require('url')
import writeJsonFile = require('write-json-file')
import createPkgId from './createNpmPkgId'
import {RegistryPackageSpec} from './parsePref'
import toRaw from './toRaw'

class PnpmError extends Error {
  public code: string
  constructor (code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface PackageMeta {
  'dist-tag': { [name: string]: string },
  versions: {
    [name: string]: PackageInRegistry,
  }
}

export type PackageInRegistry = PackageManifest & {
  dist: {
    integrity?: string,
    shasum: string,
    tarball: string,
  },
}

// prevents simultainous operations on the meta.json
// otherwise it would cause EPERM exceptions
const metafileOperationLimits = {}

export default async function loadPkgMetaNonCached (
  getJson: <T> (url: string, registry: string, auth?: object) => Promise<T>,
  spec: RegistryPackageSpec,
  opts: {
    auth: object,
    storePath: string,
    metaCache: Map<string, PackageMeta>,
    offline: boolean,
    registry: string,
  },
): Promise<PackageMeta> {
  opts = opts || {}

  if (opts.metaCache.has(spec.name)) {
    return opts.metaCache.get(spec.name) as PackageMeta
  }

  const registryName = getRegistryName(opts.registry)
  const pkgMirror = path.join(opts.storePath, registryName, spec.name)
  const limit = metafileOperationLimits[pkgMirror] = metafileOperationLimits[pkgMirror] || pLimit(1)

  if (opts.offline) {
    const meta = await limit(() => loadMeta(pkgMirror))

    if (meta) return meta

    throw new PnpmError('NO_OFFLINE_META', `Failed to resolve ${toRaw(spec)} in package mirror ${pkgMirror}`)
  }

  if (spec.type === 'version') {
    const meta = await limit(() => loadMeta(pkgMirror))
    // use the cached meta only if it has the required package version
    // otherwise it is probably out of date
    if (meta && meta.versions && meta.versions[spec.fetchSpec]) {
      return meta
    }
  }

  try {
    const meta = await fromRegistry(getJson, spec.name, opts.registry, opts.auth)
    // only save meta to cache, when it is fresh
    opts.metaCache.set(spec.name, meta)
    limit(() => saveMeta(pkgMirror, meta))
    return meta
  } catch (err) {
    const meta = await loadMeta(opts.storePath)
    if (!meta) throw err
    logger.error(err)
    logger.info(`Using cached meta from ${opts.storePath}`)
    return meta
  }
}

async function fromRegistry (
  getJson: <T>(url: string, registry: string, auth?: object) => Promise<T>,
  pkgName: string,
  registry: string,
  auth: object,
) {
  const uri = toUri(pkgName, registry)
  const meta = await getJson<PackageMeta>(uri, registry, auth)
  return meta
}

// This file contains meta information
// about all the packages published by the same name, not just the manifest
// of one package/version
const META_FILENAME = 'index.json'

async function loadMeta (pkgMirror: string): Promise<PackageMeta | null> {
  try {
    return await loadJsonFile(path.join(pkgMirror, META_FILENAME))
  } catch (err) {
    return null
  }
}

function saveMeta (pkgMirror: string, meta: PackageMeta): Promise<void> {
  return writeJsonFile(path.join(pkgMirror, META_FILENAME), meta)
}

function toUri (pkgName: string, registry: string) {
  let encodedName: string

  if (pkgName[0] === '@') {
    encodedName = `@${encodeURIComponent(pkgName.substr(1))}`
  } else {
    encodedName = encodeURIComponent(pkgName)
  }

  return url.resolve(registry, encodedName)
}
