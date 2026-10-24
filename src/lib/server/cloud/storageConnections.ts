import { createHash } from 'node:crypto';
import {
  createStorageContextId,
  describeStorageDescriptor,
  type IdentifiedStoragePort,
  type StorageDescriptor
} from './storageRegistry';
import { YandexDiskAdapter } from './yandexDiskAdapter';
import { DropboxAdapter } from './dropboxAdapter';
import { checkIsRegistryId, checkIsIdentityText } from '../../utils/storageValidation';

export interface StorageConnection {
  id: string;
  label: string;
  provider: string;
  storage: IdentifiedStoragePort;
  descriptor?: StorageDescriptor;
  rootPath?: string;
}

export interface StorageConnections {
  activeStorageId: string;
  storages: StorageConnection[];
}

export type PublicConnection =
  | (StorageDescriptor & { status: 'available' })
  | { id: string; label: string; provider: string; rootPath?: string; status: 'unavailable' };

export interface ConnectionCatalog {
  activeStorageId: string;
  storages: PublicConnection[];
}

const configurationError = 'Invalid cloud storage configuration';
type Configuration = { id: string; label: string; provider: string; [key: string]: unknown };

const providers = new Map<
  string,
  (entry: Configuration) => { storage: IdentifiedStoragePort; rootPath: string }
>([
  [
    'yandex',
    entry => ({
      storage: new YandexDiskAdapter({
        accessToken: entry.accessToken as string,
        rootPath: entry.rootPath as string
      }),
      rootPath: `disk:/${entry.rootPath}`
    })
  ],
  [
    'dropbox',
    entry => ({
      storage: new DropboxAdapter({
        appKey: entry.appKey as string,
        appSecret: entry.appSecret as string,
        refreshToken: entry.refreshToken as string,
        rootPath: entry.rootPath as string
      }),
      rootPath: (entry.rootPath as string) || '/'
    })
  ]
]);
let cached: { key: string; activeStorageId: string; storages: StorageConnection[] } | undefined;

// Cache adapters (and their short-lived OAuth tokens), never verified identities.
// Every resolution rechecks the account and physical folder before authorizing I/O.
export function createStorageConnections(
  environment: Record<string, string | undefined>
): StorageConnections {
  const settings = environment.CLOUD_STORAGES;
  const activeStorageId = environment.CLOUD_STORAGE_ACTIVE;
  if (!settings || !activeStorageId) throw new Error(configurationError);
  const key = createHash('sha256')
    .update(JSON.stringify([settings, activeStorageId]))
    .digest('hex');
  if (cached?.key === key)
    return { activeStorageId: cached.activeStorageId, storages: cached.storages };
  try {
    const entries: Configuration[] = JSON.parse(settings);
    if (!Array.isArray(entries) || !entries.length) throw new Error();
    const ids = new Set<string>();
    const storages = entries.map(entry => {
      if (
        !entry ||
        !checkIsRegistryId(entry.id) ||
        ids.has(entry.id) ||
        !checkIsIdentityText(entry.label)
      )
        throw new Error();
      ids.add(entry.id);
      const factory = providers.get(entry.provider);
      if (!factory) throw new Error();
      return { id: entry.id, label: entry.label, provider: entry.provider, ...factory(entry) };
    });
    if (typeof activeStorageId !== 'string' || !ids.has(activeStorageId)) throw new Error();
    cached = { key, activeStorageId, storages };
    return { activeStorageId, storages };
  } catch {
    throw new Error(configurationError);
  }
}

export async function resolveStorageConnections(
  environment: Record<string, string | undefined>,
  selection: boolean | ReadonlySet<string> = false
): Promise<StorageConnections> {
  const configured = createStorageConnections(environment);
  const identities = await Promise.all(
    configured.storages.map(async entry => {
      if (
        (selection === true && entry.id !== configured.activeStorageId) ||
        (selection instanceof Set && !selection.has(entry.id))
      )
        return { status: 'unavailable' } as const;
      try {
        return await entry.storage.identify();
      } catch {
        return { status: 'unavailable' } as const;
      }
    })
  );
  const targets = new Set<string>();
  const storages = configured.storages.map((entry, index) => {
    const result = identities[index];
    if (result.status !== 'success') return { ...entry };
    const targetKey = JSON.stringify([
      result.identity.provider,
      result.identity.accountId,
      result.identity.rootId
    ]);
    if (targets.has(targetKey)) throw new Error(configurationError);
    targets.add(targetKey);
    try {
      const descriptor: StorageDescriptor = {
        id: entry.id,
        label: entry.label,
        provider: entry.provider,
        ...(entry.rootPath === undefined ? {} : { rootPath: entry.rootPath }),
        contextId: createStorageContextId(entry.id, result.identity),
        capabilities: entry.storage.getCapabilities()
      };
      return { ...entry, descriptor: describeStorageDescriptor(descriptor) };
    } catch {
      return { ...entry };
    }
  });
  return { activeStorageId: configured.activeStorageId, storages };
}

export function describeConnections(connections: StorageConnections): ConnectionCatalog {
  return {
    activeStorageId: connections.activeStorageId,
    storages: connections.storages.map(entry =>
      entry.descriptor
        ? { ...describeStorageDescriptor(entry.descriptor), status: 'available' }
        : {
            id: entry.id,
            label: entry.label,
            provider: entry.provider,
            ...(entry.rootPath === undefined ? {} : { rootPath: entry.rootPath }),
            status: 'unavailable'
          }
    )
  };
}
