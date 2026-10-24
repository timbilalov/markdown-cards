import type { mockHttp } from './http';

export const browserStorageDescriptor = {
  id: 'yandex',
  label: 'Яндекс Диск',
  provider: 'yandex',
  contextId: `ctx-v1-${'e'.repeat(64)}`,
  capabilities: { revisions: false, conditionalCreate: true },
  status: 'available' as const
};

export function mockStorageCatalog(http: ReturnType<typeof mockHttp>) {
  http.on('GET', '/api/storages', () =>
    Response.json({
      activeStorageId: browserStorageDescriptor.id,
      storages: [browserStorageDescriptor]
    })
  );
}

export async function initializeTestStorage(http: ReturnType<typeof mockHttp>) {
  mockStorageCatalog(http);
  await (await import('../../services/storageSession')).initializeStorageSession(true);
}

export async function currentTestDatabaseName(): Promise<string> {
  const context = (await import('../../services/storageSession')).getStorageSession()?.descriptor
    ?.contextId;
  return context ? `MarkdownCardsDB:${context}` : 'MarkdownCardsDB';
}
