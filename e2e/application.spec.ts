import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { createProductionHttp, productionCredentials, productionOrigin as origin } from '../src/lib/tests/helpers/productionHttp';
import { legacyRecords } from '../src/lib/tests/helpers/legacyDatabase';

let server: Awaited<ReturnType<typeof createProductionHttp>>;
let assets: Set<string>;
let legacy: string;
let releaseUpload: (() => void) | undefined;
let holdUpload = false;
let offline = false;
let errors: string[] = [];
const remotePath = 'md-cards/existing-note.md';
const mime: Record<string, string> = { '.js': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json' };

test.beforeAll(async () => {
  server = await createProductionHttp();
  assets = new Set((await server.readClientAssets()).map(asset => asset.path));
  legacy = (await readFile('src/lib/tests/fixtures/migration-legacy.md', 'utf8'))
    .replace('![](https://example.invalid/cover.png)\n\n', '');
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ context }) => {
  await server.reset({ [remotePath]: legacy });
  holdUpload = false; offline = false; errors = [];
  context.on('page', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (/Content-Security-Policy|violates.*directive/i.test(message.text())) errors.push(message.text());
    });
  });
  // Serve real production HTML/API/assets. Only external I/O is substituted,
  // in the worker's in-memory Yandex fixture; no connection to user cloud data.
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || offline) { await route.abort(); return; }
    const path = decodeURIComponent(url.pathname.slice(1));
    if (assets.has(path)) {
      await route.fulfill({ body: Buffer.from(await server.readClientAssetBytes(path)),
        contentType: mime[extname(path)] ?? 'application/octet-stream' });
      return;
    }
    const response = await server.request({ url: url.href, method: request.method(),
      headers: await request.allHeaders(), bodyBytes: request.postDataBuffer() ? [...request.postDataBuffer()!] : undefined });
    if (url.pathname === '/api/cloud/upload' && holdUpload) {
      holdUpload = false;
      await new Promise<void>(resolve => { releaseUpload = resolve; });
    }
    const headers = { ...response.headers };
    if (response.cookies.length) headers['set-cookie'] = response.cookies.join('\n');
    await route.fulfill({ status: response.status, headers, body: response.text }).catch(() => {
      // The recovery drill intentionally closes the page before its acknowledgement.
      if (!request.frame().page().isClosed()) throw new Error('Unexpected response delivery failure');
    });
  });
});
test.afterEach(async () => {
  releaseUpload?.(); releaseUpload = undefined;
  expect(errors).toEqual([]);
  const response = await server.request({ url: `${origin}/api/auth/status` });
  expect(response.effects.unexpected).toEqual([]);
  expect(response.effects.databaseOpens).toBe(0);
});

async function login(page: Page) {
  await page.goto(`${origin}/login`);
  await page.getByLabel('Username', { exact: true }).fill(productionCredentials.username);
  await page.getByLabel('Password', { exact: true }).fill(productionCredentials.password);
  await page.getByLabel('Password', { exact: true }).press('Enter');
  await expect(page).toHaveURL(`${origin}/`);
}
async function migrate(page: Page) {
  await page.goto(`${origin}/card/existing-note`);
  const migrate = page.getByRole('button', { name: 'Обновить формат', exact: true });
  await expect(migrate).toBeVisible();
  await migrate.focus();
  await page.keyboard.press('Enter');
  await expect(migrate).toHaveCount(0);
  await expect(page.getByLabel('Название заметки')).toHaveValue('Карточка 🗂');
}
async function effects() {
  return (await server.request({ url: `${origin}/api/auth/status` })).effects;
}
async function state(page: Page, legacy = false) {
  return page.evaluate(async legacy => {
    let name='MarkdownCardsDB';
    if(!legacy){
      const manifest=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('MarkdownCardsContexts');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
      try{
        const context=await new Promise<unknown>((resolve,reject)=>{const tx=manifest.transaction('meta');const request=tx.objectStore('meta').get('active');tx.oncomplete=()=>resolve(request.result);tx.onabort=()=>reject(tx.error);});
        if(typeof context==='string')name+=`:${context}`;
      }finally{manifest.close();}
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{ version: number; records: Record<string, unknown[]> }>((resolve, reject) => {
        const names = [...db.objectStoreNames]; const tx = db.transaction(names, 'readonly');
        const requests = names.map(name => tx.objectStore(name).getAll());
        tx.oncomplete = () => resolve({ version: db.version, records: Object.fromEntries(names.map((name, i) => [name, requests[i].result])) });
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, legacy);
}
async function connectivity(context: BrowserContext, connected: boolean) {
  offline = !connected;
  await context.setOffline(!connected);
}

test('mobile keyboard migration, online Save, offline Save and restart/reconnect preserve exact Markdown', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(page.getByRole('link', { name: /existing-note/ })).toBeVisible();
  const menu = page.getByRole('button', { name: 'menu', exact: true });
  await menu.focus(); await page.keyboard.press('Enter');
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'Sign Out' })).toBeVisible();
  await page.keyboard.press('Enter');
  await migrate(page);
  expect((await effects()).writes).toEqual([]);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(/Сохранено.*Яндекс Диск/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Обновить формат' })).toHaveCount(0);
  await expect(page.getByLabel('Название заметки')).toHaveValue('Карточка 🗂');
  await connectivity(context, false);
  await page.getByLabel('Название заметки').fill('Offline edit 🗂');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Сохранено локально');
  const saved = (await state(page)).records.localMarkdownSnapshots[0] as { source: string };
  expect(saved.source).toContain('Offline edit 🗂');
  expect((await effects()).writes).toHaveLength(1);
  await page.close();
  await connectivity(context, true);
  const restarted = await context.newPage();
  await restarted.goto(`${origin}/card/existing-note`);
  await expect(restarted.getByLabel('Название заметки')).toHaveValue('Offline edit 🗂');
  await expect(restarted.getByRole('status')).toHaveText(/Сохранено.*Яндекс Диск/);
  expect((await effects()).remote[remotePath]).toBe(saved.source);
  expect((await state(restarted)).records.localMarkdownSnapshots).toEqual([]);
  await restarted.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(restarted.getByRole('link', { name: /Offline edit/ })).toBeVisible();
  expect(await restarted.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('changed remote document stops overwrite and retains the local draft across reload', async ({ page }) => {
  await login(page); await migrate(page);
  const changed = legacy.replace('Первый абзац', 'Remote edit');
  await server.reset({ [remotePath]: changed });
  await page.getByLabel('Название заметки').fill('Local conflict');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('конфликт');
  const saved = (await state(page)).records.localMarkdownSnapshots;
  expect((await effects()).remote[remotePath]).toBe(changed);
  expect((await effects()).writes).toEqual([]);
  await page.reload();
  await expect(page.getByLabel('Название заметки')).toHaveValue('Local conflict');
  await expect(page.getByRole('alert')).toContainText('конфликт');
  expect((await state(page)).records.localMarkdownSnapshots).toEqual(saved);
});

test('lost upload acknowledgement: restart retains exact local/remote Markdown and prevents duplicate delivery', async ({ page, context }) => {
  await login(page); await migrate(page);
  holdUpload = true;
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await effects()).writes.length).toBe(1);
  const before = await state(page);
  const saved = before.records.localMarkdownSnapshots[0] as { source: string };
  expect(before.records.outbox).toEqual([expect.objectContaining({ state: expect.objectContaining({ status: 'processing' }) })]);
  await page.close(); releaseUpload?.(); releaseUpload = undefined;
  const restarted = await context.newPage();
  await restarted.goto(`${origin}/card/existing-note`);
  await expect(restarted.getByRole('alert')).toContainText('результат записи в облако неизвестен');
  expect((await state(restarted)).records.outbox).toEqual([expect.objectContaining({ state: expect.objectContaining({ status: 'uncertain' }) })]);
  expect((await effects()).remote[remotePath]).toBe(saved.source);
  expect((await state(restarted)).records.localMarkdownSnapshots).toEqual(before.records.localMarkdownSnapshots);
  await restarted.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await effects()).writes).toHaveLength(1);
});

test('does not expose or deliver an unassigned database as a configured storage cache', async ({ context, page }) => {
  // Seed before any application JavaScript opens IndexedDB, in the same real origin/profile.
  await context.addInitScript(async records => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', 'true');
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('MarkdownCardsDB', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        const cards = db.createObjectStore('cards', { keyPath: 'meta.id' });
        cards.createIndex('title', 'meta.title'); cards.createIndex('modified', 'meta.modified');
        const files = db.createObjectStore('files', { keyPath: 'path' });
        files.createIndex('name', 'name'); files.createIndex('modified', 'modified');
        const queue = db.createObjectStore('syncQueue', { keyPath: 'id' });
        queue.createIndex('timestamp', 'timestamp'); queue.createIndex('status', 'status');
        for (const row of records.cards) cards.put(row);
        for (const row of records.files) files.put(row);
        for (const row of records.syncQueue) queue.put(row);
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
  }, legacyRecords);
  await server.reset({});
  await login(page);
  await expect(page.getByRole('link', { name: /Карточка/ })).toHaveCount(0);
  await page.goto(`${origin}/storages`);
  await expect(page.getByRole('columnheader',{name:'Локальный кеш · прежняя база без привязки',exact:true})).toHaveCount(0);
  const upgraded = await state(page,true);
  expect(upgraded.version).toBe(6);
  expect((await state(page)).records.outbox).toEqual([]);
  expect(upgraded.records.cards).toEqual(legacyRecords.cards);
  expect(upgraded.records.files).toEqual(legacyRecords.files);
  expect(upgraded.records.syncQueue).toEqual([...legacyRecords.syncQueue].sort((a, b) => a.id.localeCompare(b.id)));
  expect((await effects()).writes).toEqual([]);
});


test('mobile multi-column board and editor expose named keyboard controls without page overflow', async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const source = (await readFile('src/lib/tests/fixtures/v1-card.md', 'utf8'))
    .replace('![](https://example.invalid/cover.png)\n\n', '');
  await server.reset(Object.fromEntries(['Todo', 'Doing', 'Done'].map((status, i) => [
    `md-cards/note-${i}.md`, source.replace('Карточка 🗂', `${status} note`).replace('В процессе', ['Предстоящие', 'В процессе', 'Done'][i]).replace('test-card', `note-${i}`)
  ])));
  await login(page);
  // A fresh profile first lists filenames; Save adds a local Card projection.
  const first = page.getByRole('link', { name: /^note-0 / });
  await first.focus(); await page.keyboard.press('Enter');
  await expect(page.getByLabel('Название заметки')).toHaveValue('Todo note');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(/Сохранено.*Яндекс Диск/);
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('link', { name: /Todo note/ })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2 })).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-board.png'), fullPage: true });
  const last = page.getByRole('link', { name: /Todo note/ });
  await last.focus();
  await expect(last).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Название заметки')).toHaveValue('Todo note');
  const session = await context.newCDPSession(page);
  const tree = await session.send('Accessibility.getFullAXTree');
  const roles = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox']);
  const unnamed = tree.nodes.filter(node => !node.ignored && roles.has(node.role?.value)
    && !String(node.name?.value ?? '').trim()).map(node => node.role?.value);
  expect(unnamed).toEqual([]);
  await session.detach();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-editor.png'), fullPage: true });
});

test('guest startup and logout do not request cloud files; login resumes loading without reload', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/cloud/')) requests.push(path);
  });
  // Chromium does not re-intercept the redirect leg of a fulfilled route.
  // Check the actual anonymous root response, then open its actual target.
  const anonymous = await server.request({ url: `${origin}/` });
  expect(anonymous.status).toBe(302);
  expect(anonymous.headers.location).toBe('/login');
  await page.goto(new URL(anonymous.headers.location, origin).href);
  await expect(page).toHaveURL(`${origin}/login`);
  await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  // Observe the real startup timer window. Absence must hold past the old 5s
  // trigger, not just during the initial render or a fake app initialization.
  await page.waitForTimeout(5500);
  expect(requests).toEqual([]);

  async function submitLogin() {
    await page.getByLabel('Username', { exact: true }).fill(productionCredentials.username);
    await page.getByLabel('Password', { exact: true }).fill(productionCredentials.password);
    await page.getByLabel('Password', { exact: true }).press('Enter');
    await expect(page).toHaveURL(`${origin}/`);
    await expect(page.getByRole('link', { name: /existing-note/ })).toBeVisible();
  }
  await submitLogin();
  expect(requests).toContain('/api/cloud/files');
  await page.getByRole('button', { name: 'Sign Out' }).click();
  await expect(page).toHaveURL(`${origin}/login`);
  requests.length = 0;
  await page.waitForTimeout(5500);
  expect(requests).toEqual([]);
  await submitLogin();
  expect(requests).toContain('/api/cloud/files');
});

test('Home after logout redirects to login without exposing or deleting cached cards', async ({ page }) => {
  await server.reset({ [remotePath]: legacy.replace('test-card', 'existing-note') });
  await login(page);
  await migrate(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(/Сохранено.*Яндекс Диск/);
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('link', { name: /Карточка/ })).toBeVisible();
  const cached = (await state(page)).records.cards;
  expect(cached).toHaveLength(1);

  await page.getByRole('button', { name: 'Sign Out' }).click();
  await expect(page).toHaveURL(`${origin}/login`);
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  // Observe the settled SPA navigation: a full page.goto would exercise only
  // the already working server redirect and miss this client-side disclosure.
  // Do not mistake the previous login form for a successful redirect while
  // the click's asynchronous client navigation is still starting.
  await page.waitForTimeout(500);
  await page.waitForFunction(() => document.querySelector('.status-bar')?.textContent?.includes('Loaded from')
    || (location.pathname === '/login' && document.querySelector('input#username')));
  expect.soft(await page.locator('a[data-source]').count()).toBe(0);
  expect.soft(page.url()).toBe(`${origin}/login`);
  expect((await state(page)).records.cards).toEqual(cached);
});
