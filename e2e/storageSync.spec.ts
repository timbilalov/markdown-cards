import {
  historicalDescriptor,
  historicalLocalId
} from '../src/lib/tests/helpers/historicalStorageContext';
import { test, expect, type Page } from '@playwright/test';
import {
  createProductionHttp,
  productionOrigin as origin,
  productionCredentials
} from '../src/lib/tests/helpers/productionHttp';
import { multiStorageProduction } from '../src/lib/tests/helpers/multiStorageProduction';
import { serveProduction } from './helpers/browserServer';
import { readFile } from 'node:fs/promises';

let server: Awaited<ReturnType<typeof createProductionHttp>>;
let older: string;
let newer: string;
let loseAcknowledgement = false;
let errors: string[] = [];
const raw = '\uFEFF<!-- markdown-cards: 99 -->\r\nKEEP 🗂\r\n';
test.beforeAll(async () => {
  server = await createProductionHttp({
    storages: multiStorageProduction,
    activeStorageId: 'dropbox'
  });
  older = await readFile('src/lib/tests/fixtures/v1-minimal.md', 'utf8');
  newer = older.replace('2026-09-24T00:00:00.000Z', '2026-09-25T00:00:00.000Z');
});

test.afterAll(async () => {
  await server?.close();
});

test.beforeEach(async ({ context }) => {
  errors = [];
  loseAcknowledgement = false;
  await server.reset({
    'md-cards/note.md': older,
    'md-cards/disk-only.md': 'disk only',
    'dropbox:/note.md': newer,
    'dropbox:/raw.md': raw,
    'Archive/reserve-only.md': 'archive only'
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await serveProduction(context, server, {
    beforeResponse: async route => {
      if (loseAcknowledgement && new URL(route.request().url()).pathname.endsWith('/copy')) {
        loseAcknowledgement = false;
        return false;
      }
    }
  });
});

test.afterEach(async () => {
  expect(errors).toEqual([]);
  expect((await effects()).unexpected).toEqual([]);
});

async function effects() {
  return (await server.request({ url: `${origin}/api/auth/status` })).effects;
}

async function login(page: Page) {
  await page.goto(`${origin}/login`);
  await page.getByLabel('Username', { exact: true }).fill(productionCredentials.username);
  await page.getByLabel('Password', { exact: true }).fill(productionCredentials.password);
  await page.getByLabel('Password', { exact: true }).press('Enter');
  await expect(page).toHaveURL(`${origin}/`);
}

async function localSource(
  page: Page,
  databaseName = `MarkdownCardsDB:${historicalDescriptor.contextId}`
) {
  await page.evaluate(
    async ({ source, databaseName, descriptor }) => {
      if (databaseName === `MarkdownCardsDB:${descriptor.contextId}`) {
        const manifest = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('MarkdownCardsContexts', 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          await new Promise<void>((resolve, reject) => {
            const tx = manifest.transaction('contexts', 'readwrite');
            tx.objectStore('contexts').put(descriptor);
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error);
          });
        } finally {
          manifest.close();
        }
      }
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName);
        request.onupgradeneeded = () =>
          request.result.createObjectStore('markdownDocuments', { keyPath: 'filename' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('markdownDocuments', 'readwrite');
          tx.objectStore('markdownDocuments').put({ filename: 'note', source });
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },
    { source: older, databaseName, descriptor: historicalDescriptor }
  );
}

async function management(page: Page) {
  await page.goto(`${origin}/storages`);
  await expect(page.locator('[data-storage-table] tr[data-note-path="note.md"]')).toBeVisible();
}

async function select(page: Page, source: string, targets: string[], path = '') {
  await page.getByLabel('Заметки', { exact: true }).selectOption(path);
  await page.getByLabel('Эталон', { exact: true }).selectOption(source);
  await page.getByRole('button', { name: 'Сбросить все', exact: true }).click();
  for (const id of targets) await page.locator(`input[type="checkbox"][value="${id}"]`).check();
  await page.getByRole('button', { name: 'Подготовить синхронизацию', exact: true }).click();
  await expect(page.locator('[data-sync-preview]')).toBeVisible();
}

test('blocks the interface and reports loading progress on entry, refresh and after synchronization', async ({
  page
}, info) => {
  await login(page);
  const listing = Promise.withResolvers<void>();
  const copying = Promise.withResolvers<void>();
  const copyStarted = Promise.withResolvers<void>();
  const downloads: (() => void)[] = [];
  let allowDownloads = false;
  await page.route(url => /^\/api\/storages\/[^/]+\/files$/.test(url.pathname), async route => {
    await listing.promise;
    await route.fallback();
  });
  await page.route(url => /^\/api\/storages\/[^/]+\/download$/.test(url.pathname), async route => {
    if (!allowDownloads) {
      const gate = Promise.withResolvers<void>();
      downloads.push(() => gate.resolve());
      await gate.promise;
    }
    await route.fallback();
  });
  await page.route(url => /^\/api\/storages\/[^/]+\/copy$/.test(url.pathname), async route => {
    copyStarted.resolve();
    await copying.promise;
    await route.fallback();
  });
  const dialog = page.getByRole('dialog', { name: 'Обновление хранилищ', exact: true });
  const progress = dialog.getByRole('progressbar');
  const releaseDownloads = () => {
    allowDownloads = true;
    downloads.splice(0).forEach(release => release());
  };
  try {
    await page.getByRole('link', { name: 'Хранилища', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Получаем списки файлов');
    await expect(progress).not.toHaveAttribute('value');
    expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await page.getByRole('link', { name: 'Home', exact: true }).evaluate(element => element.focus());
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await expect(page.getByRole('button', { name: 'Обновить версии', exact: true })).toBeDisabled();

    listing.resolve();
    await expect.poll(() => downloads.length).toBe(4);
    await expect(dialog).toContainText('Обработано копий:');
    const before = Number(await progress.getAttribute('value'));
    downloads.shift()!();
    await expect.poll(async () => Number(await progress.getAttribute('value'))).toBeGreaterThan(before);
    await page.screenshot({ path: info.outputPath('storage-loading.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: info.outputPath('storage-loading-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    releaseDownloads();
    await expect(dialog).not.toBeVisible();

    allowDownloads = false;
    await page.getByRole('button', { name: 'Обновить версии', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(progress).toHaveAttribute('value', /\d+/);
    releaseDownloads();
    await expect(dialog).not.toBeVisible();

    await select(page, 'disk', ['dropbox'], 'note.md');
    await page.getByRole('button', { name: 'Выполнить синхронизацию', exact: true }).click();
    await expect(dialog).toContainText('Синхронизируем заметки');
    await expect(progress).not.toHaveAttribute('value');
    await copyStarted.promise;
    allowDownloads = false;
    copying.resolve();
    await expect(dialog).toContainText('Обработано копий:');
    await expect(progress).toHaveAttribute('value', /\d+/);
    expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
    releaseDownloads();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Обновить версии', exact: true })).toBeEnabled();
    await expect(page.getByText('Записано', { exact: true })).toBeVisible();
  } finally {
    listing.resolve();
    copying.resolve();
    releaseDownloads();
  }
});

test('compares three clouds and local cache, then explicitly replaces latest Dropbox with an older local reference', async ({
  page
}, info) => {
  await login(page);
  await localSource(page);
  await management(page);
  const headers = page.locator('[data-storage-table] thead th');
  await expect(page.locator('[data-storage-table] thead th[data-storage-id="disk"]')).toContainText(
    'Папка: disk:/md-cards'
  );
  await expect(headers.nth(1)).toContainText('Папка: /');
  const caches = page.getByRole('region', { name: 'Локальные кэши', exact: true });
  const activeCacheId = await caches
    .locator('[data-cache-id]')
    .filter({ hasText: 'Текущее подключение' })
    .getAttribute('data-cache-id');
  await expect(headers.nth(1)).toHaveAttribute('data-storage-id', 'dropbox');
  await expect(headers.nth(2)).toHaveAttribute('data-storage-id', activeCacheId!);
  const columnIds = await headers.evaluateAll(elements =>
    elements.slice(1).map(element => element.getAttribute('data-storage-id'))
  );
  expect(
    await page
      .locator('tr[data-note-path="note.md"] td')
      .evaluateAll(elements => elements.map(element => element.getAttribute('data-storage-id')))
  ).toEqual(columnIds);
  await expect(
    caches.locator(`[data-cache-id="${historicalLocalId}"] [data-cache-folder]`)
  ).toHaveText('Папка неизвестна');
  await expect(
    caches
      .locator('[data-cache-id]')
      .filter({ hasText: 'Локальный кеш · Основной Диск ·' })
      .locator('[data-cache-folder]')
  ).toHaveText('disk:/md-cards');
  await expect(page.locator('select[aria-label="Эталон"] option[value="disk"]')).toContainText(
    'disk:/md-cards'
  );
  const row = page.locator('tr[data-note-path="note.md"]');
  await expect(row.locator('td[data-storage-id="dropbox"]')).toHaveAttribute('data-latest', 'true');
  await expect(row.locator(`td[data-storage-id="${historicalLocalId}"]`)).toHaveAttribute(
    'data-latest',
    'false'
  );
  expect((await effects()).writes).toEqual([]);
  await select(page, historicalLocalId, ['dropbox'], 'note.md');
  expect((await effects()).writes).toEqual([]);
  await page.getByRole('button', { name: 'Выполнить синхронизацию', exact: true }).click();
  await expect(page.getByText('Записано', { exact: true })).toBeVisible();
  expect((await effects()).remote['dropbox:/note.md']).toBe(older);
  expect((await effects()).remote['md-cards/note.md']).toBe(older);
  expect((await effects()).writes).toHaveLength(1);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('storage-comparison.png'), fullPage: true });
});

test('batch copies exact unsupported text to several destinations and skips files missing in the reference', async ({
  page
}) => {
  await login(page);
  await management(page);
  await select(page, 'dropbox', ['disk', 'archive']);
  await expect(page.locator('[data-sync-preview]')).toContainText('Нет в эталоне');
  await page.getByRole('button', { name: 'Выполнить синхронизацию', exact: true }).click();
  await expect.poll(async () => (await effects()).writes.length).toBe(4);
  const result = await effects();
  expect(result.remote['md-cards/note.md']).toBe(newer);
  expect(result.remote['Archive/note.md']).toBe(newer);
  expect(result.remote['md-cards/raw.md']).toBe(raw);
  expect(result.remote['Archive/raw.md']).toBe(raw);
  expect(result.remote['md-cards/disk-only.md']).toBe('disk only');
  expect(result.remote['Archive/reserve-only.md']).toBe('archive only');
});

test('queues several notes with different references and destinations before a single execution', async ({
  page
}, info) => {
  await login(page);
  await management(page);
  await select(page, 'dropbox', ['disk', 'archive'], 'note.md');
  await select(page, 'disk', ['dropbox'], 'disk-only.md');
  await select(page, 'archive', ['disk'], 'reserve-only.md');
  const queue = page.locator('[data-sync-preview]');
  await expect(queue.locator('li')).toHaveCount(4);
  await expect(queue).toContainText('К копированию: 4');
  expect((await effects()).writes).toEqual([]);
  await queue.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('sync-queue.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await queue.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('sync-queue-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Выполнить синхронизацию', exact: true }).click();
  await expect(page.getByText('Записано', { exact: true })).toHaveCount(4);
  await expect(queue).toHaveCount(0);
  const result = await effects();
  expect(result.writes).toHaveLength(4);
  expect(result.remote['md-cards/note.md']).toBe(newer);
  expect(result.remote['Archive/note.md']).toBe(newer);
  expect(result.remote['dropbox:/disk-only.md']).toBe('disk only');
  expect(result.remote['md-cards/reserve-only.md']).toBe('archive only');
});

test('rechecks queued versions and completes independent operations after another destination changes', async ({
  page
}) => {
  await login(page);
  await management(page);
  await select(page, 'dropbox', ['disk'], 'note.md');
  await select(page, 'archive', ['dropbox'], 'reserve-only.md');
  await server.reset({
    'md-cards/note.md': 'changed after preparation',
    'md-cards/disk-only.md': 'disk only',
    'dropbox:/note.md': newer,
    'dropbox:/raw.md': raw,
    'Archive/reserve-only.md': 'archive only'
  });
  await page.getByRole('button', { name: 'Выполнить синхронизацию', exact: true }).click();
  await expect(page.getByText('Назначение изменилось — обновите версии', { exact: true })).toBeVisible();
  await expect(page.getByText('Записано', { exact: true })).toBeVisible();
  const result = await effects();
  expect(result.writes).toHaveLength(1);
  expect(result.remote['md-cards/note.md']).toBe('changed after preparation');
  expect(result.remote['dropbox:/reserve-only.md']).toBe('archive only');
});

test('groups a historical Dropbox cache with its active connection in the table and both selectors', async ({
  page
}) => {
  await login(page);
  const contextId = `ctx-v1-${'d'.repeat(56)}24bee099`;
  const historicalId = `local:${contextId}`;
  await page.evaluate(
    async descriptor => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('MarkdownCardsContexts', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction('contexts', 'readwrite');
          transaction.objectStore('contexts').put(descriptor);
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(transaction.error);
        });
      } finally {
        database.close();
      }
    },
    {
      id: 'dropbox',
      label: 'Dropbox резерв',
      provider: 'dropbox',
      contextId,
      rootPath: '/Previous',
      capabilities: {
        revisions: true,
        conditionalCreate: true,
        conditionalUpdate: true,
        caseSensitivePaths: false
      }
    }
  );
  await localSource(page, `MarkdownCardsDB:${contextId}`);
  await management(page);
  const activeCacheId = await page
    .locator('[data-cache-id]')
    .filter({ hasText: 'Текущее подключение' })
    .getAttribute('data-cache-id');
  const columns = await page
    .locator('[data-storage-table] thead th[data-storage-id]')
    .evaluateAll(elements => elements.map(element => element.getAttribute('data-storage-id')));
  expect(columns.slice(0, 3)).toEqual(['dropbox', activeCacheId, historicalId]);
  expect(columns).not.toContain(historicalLocalId);
  const targets = () =>
    page
      .locator('input[type="checkbox"]')
      .evaluateAll(elements => elements.map(element => (element as HTMLInputElement).value));
  expect(await targets()).toEqual(columns);
  const references = () =>
    page
      .locator('select[aria-label="Эталон"] option')
      .evaluateAll(elements =>
        elements.map(element => (element as HTMLOptionElement).value).filter(Boolean)
      );
  expect(await references()).toContain(historicalId);
  expect(await references()).toEqual(
    columns.filter(id => ['dropbox', historicalId, 'disk', 'archive'].includes(id!))
  );
  await page.getByLabel('Заметки', { exact: true }).selectOption('note.md');
  await page.getByLabel('Эталон', { exact: true }).selectOption('dropbox');
  expect(await targets()).toEqual(columns.filter(id => id !== 'dropbox'));
  expect((await effects()).writes).toEqual([]);
});

test('lost manual acknowledgement survives reload and verifies exact desired state without another upload', async ({
  page
}) => {
  await login(page);
  await localSource(page);
  await management(page);
  await select(page, historicalLocalId, ['dropbox'], 'note.md');
  loseAcknowledgement = true;
  await page.getByRole('button', { name: 'Выполнить синхронизацию', exact: true }).click();
  await expect(
    page.getByText('Результат неизвестен — проверьте запись', { exact: true })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Проверить запись', exact: true })).toBeVisible();
  expect((await effects()).writes).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Проверить запись', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Проверить запись', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Проверить запись', exact: true })).toHaveCount(0);
  expect((await effects()).writes).toHaveLength(1);
});

test('ordinary editor Save uses active Dropbox and its acknowledged revision', async ({ page }) => {
  await login(page);
  await page.goto(`${origin}/card/note`);
  await page.getByLabel('Название заметки').fill('Dropbox edit');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(/Сохранено.*Dropbox резерв/);
  const result = await effects();
  expect(result.writes).toHaveLength(1);
  expect(result.writes[0].path).toBe('dropbox:/note.md');
  expect(result.remote['md-cards/note.md']).toBe(older);
  await page.reload();
  await expect(page.getByLabel('Название заметки')).toHaveValue('Dropbox edit');
});

test('deletes a local cache only after confirmation, keeps it removed after reload and protects the active cache', async ({
  page
}, info) => {
  await login(page);
  await localSource(page);
  await management(page);
  const caches = page.getByRole('region', { name: 'Локальные кэши', exact: true });
  const historical = caches.locator(`[data-cache-id="${historicalLocalId}"]`);
  const active = caches.locator('[data-cache-id]').filter({ hasText: 'Текущее подключение' });
  await expect(active.getByRole('button', { name: /Удалить кэш/ })).toBeDisabled();
  await expect(historical).toContainText('Заметок: 1');
  await page.screenshot({ path: info.outputPath('local-caches-light.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  const before = await effects();
  await historical.getByRole('button').click();
  const dialog = page.getByRole('dialog', { name: 'Удалить локальный кэш?', exact: true });
  await expect(dialog).toContainText('безвозвратно');
  await expect(dialog).toContainText('Локальных изменений:');
  await page.screenshot({ path: info.outputPath('delete-cache-dark-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(historical).toBeVisible();
  await historical.getByRole('button').click();
  await dialog.getByRole('button', { name: 'Удалить безвозвратно', exact: true }).click();
  await expect(historical).toHaveCount(0);
  await expect(page.locator(`td[data-storage-id="${historicalLocalId}"]`)).toHaveCount(0);
  await page.reload();
  await expect(caches).toBeVisible();
  await expect(historical).toHaveCount(0);
  await expect(caches.locator('[data-cache-id]')).toHaveCount(3);
  const after = await effects();
  expect(after.remote).toEqual(before.remote);
  expect(after.writes).toEqual([]);
  await page.screenshot({ path: info.outputPath('local-caches.png'), fullPage: true });
});

test('keeps a removed reserve cache hidden until a manual cloud write uses that connection', async ({
  page
}) => {
  await login(page);
  await management(page);
  const caches = page.getByRole('region', { name: 'Локальные кэши', exact: true });
  const reserve = caches
    .locator('[data-cache-id]')
    .filter({ hasText: 'Локальный кеш · Основной Диск ·' });
  await reserve.getByRole('button').click();
  await page.getByRole('button', { name: 'Удалить безвозвратно', exact: true }).click();
  await expect(reserve).toHaveCount(0);
  await page.getByRole('button', { name: 'Обновить версии', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Обновить версии', exact: true })).toBeEnabled();
  await expect(reserve).toHaveCount(0);
  await select(page, 'dropbox', ['disk'], 'note.md');
  await page.getByRole('button', { name: 'Выполнить синхронизацию', exact: true }).click();
  await expect(reserve).toBeVisible();
  await expect(reserve).toContainText('Заметок: 1');
  await expect(reserve).toContainText('Локальных изменений: 0');
  expect((await effects()).writes).toHaveLength(1);
});

test('waits for another tab to release the selected cache before finishing deletion', async ({
  page,
  context
}) => {
  await login(page);
  await localSource(page);
  await management(page);
  const other = await context.newPage();
  await other.goto(`${origin}/storages`);
  await other.evaluate(async databaseName => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => {
        (window as unknown as { heldCache: IDBDatabase }).heldCache = request.result;
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  }, `MarkdownCardsDB:${historicalDescriptor.contextId}`);
  const historical = page.locator(`[data-cache-id="${historicalLocalId}"]`);
  await historical.getByRole('button').click();
  await page.getByRole('button', { name: 'Удалить безвозвратно', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('ожидает закрытия другой вкладки');
  await expect(historical).toBeVisible();
  await other.close();
  await expect(historical).toHaveCount(0);
  expect((await effects()).writes).toEqual([]);
});
