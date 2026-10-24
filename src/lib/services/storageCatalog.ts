import type { StorageDescriptor } from '../server/cloud/storageRegistry';
import type { ConnectionCatalog, PublicConnection } from '../server/cloud/storageConnections';
import {
  checkIsRegistryId as id,
  checkIsIdentityText as label,
  checkIsStorageContextId
} from '../utils/storageValidation';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseStorageDescriptor(value: unknown): StorageDescriptor | null {
  if (
    !record(value) ||
    !id(value.id) ||
    !id(value.provider) ||
    !label(value.label) ||
    (value.rootPath !== undefined && !label(value.rootPath)) ||
    !checkIsStorageContextId(value.contextId) ||
    !record(value.capabilities) ||
    typeof value.capabilities.revisions !== 'boolean' ||
    typeof value.capabilities.conditionalCreate !== 'boolean' ||
    (value.capabilities.conditionalUpdate !== undefined &&
      typeof value.capabilities.conditionalUpdate !== 'boolean') ||
    (value.capabilities.caseSensitivePaths !== undefined &&
      typeof value.capabilities.caseSensitivePaths !== 'boolean')
  )
    return null;
  return {
    id: value.id,
    label: value.label,
    provider: value.provider,
    contextId: value.contextId,
    ...(value.rootPath === undefined ? {} : { rootPath: value.rootPath as string }),
    capabilities: {
      revisions: value.capabilities.revisions,
      conditionalCreate: value.capabilities.conditionalCreate,
      ...(value.capabilities.conditionalUpdate === undefined
        ? {}
        : { conditionalUpdate: value.capabilities.conditionalUpdate }),
      ...(value.capabilities.caseSensitivePaths === undefined
        ? {}
        : { caseSensitivePaths: value.capabilities.caseSensitivePaths })
    }
  };
}

export function parseStorageCatalog(value: unknown): ConnectionCatalog | null {
  if (!record(value) || !id(value.activeStorageId) || !Array.isArray(value.storages)) return null;
  const ids = new Set<string>();
  const storages: PublicConnection[] = [];
  for (const item of value.storages) {
    if (
      !record(item) ||
      !id(item.id) ||
      !id(item.provider) ||
      !label(item.label) ||
      ids.has(item.id) ||
      (item.rootPath !== undefined && !label(item.rootPath))
    )
      return null;
    ids.add(item.id);
    if (item.status === 'available') {
      const descriptor = parseStorageDescriptor(item);
      if (!descriptor) return null;
      storages.push({ ...descriptor, status: 'available' });
    } else if (item.status === 'unavailable')
      storages.push({
        id: item.id,
        label: item.label,
        provider: item.provider,
        ...(item.rootPath === undefined ? {} : { rootPath: item.rootPath as string }),
        status: 'unavailable'
      });
    else return null;
  }
  return ids.has(value.activeStorageId)
    ? { activeStorageId: value.activeStorageId, storages }
    : null;
}
