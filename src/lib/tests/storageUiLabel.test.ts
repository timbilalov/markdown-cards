import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mockHttp } from './helpers/http';

let http: ReturnType<typeof mockHttp>;
beforeEach(async () => {
  vi.resetModules();
  http = mockHttp();
  http.on('GET', '/api/storages', () =>
    Response.json({
      activeStorageId: 'reserve',
      storages: [
        {
          id: 'reserve',
          label: 'Архив Dropbox',
          provider: 'dropbox',
          status: 'available',
          contextId: `ctx-v1-${'a'.repeat(64)}`,
          capabilities: { revisions: true, conditionalCreate: true, conditionalUpdate: true }
        }
      ]
    })
  );
  await (await import('../services/storageSession')).initializeStorageSession(true);
});

afterEach(() => http.assertHandled());

it('names the configured active storage in the successful Save message', async () => {
  expect((await import('../services/cardSyncRuntime')).describeSyncStatus('synced')).toContain(
    'Архив Dropbox'
  );
});

it.each([
  ['conflict', /конфликт.*Автоматическая перезапись остановлена/],
  ['uncertain', /результат записи в облако неизвестен.*Автоматический повтор остановлен/],
  ['not-found', /Заметка не найдена/],
  ['validation-error', /Некорректный документ.*Отправка в облако заблокирована/],
  ['remote-unavailable', /Сервис недоступен.*повторим синхронизацию позже/]
] as const)(
  'explains the Dropbox %s outcome without naming another provider',
  async (status, outcome) => {
    const message = (await import('../services/cardSyncRuntime')).describeSyncStatus(status);
    expect(message).toMatch(outcome);
    expect(message).not.toMatch(/Яндекс|Диск/);
  }
);
