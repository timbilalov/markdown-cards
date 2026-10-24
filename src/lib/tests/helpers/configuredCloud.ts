import { createStorageConnections } from '../../server/cloud/storageConnections';

export function yandexEnvironment(
  accessToken: string,
  rootPath: string,
  change: Record<string, unknown> = {}
) {
  return {
    CLOUD_STORAGE_ACTIVE: 'yandex',
    CLOUD_STORAGES: JSON.stringify([
      { id: 'yandex', label: 'Яндекс Диск', provider: 'yandex', accessToken, rootPath, ...change }
    ])
  };
}

// Isolated route tests bypass hooks. Full HTTP suites verify identity and binding.
export function configuredCloudLocals(environment: Record<string, string | undefined>) {
  try {
    const connections = createStorageConnections(environment);
    return {
      cloudStorage: connections.storages.find(entry => entry.id === connections.activeStorageId)!
        .storage
    };
  } catch {
    return {};
  }
}
