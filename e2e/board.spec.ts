import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createProductionHttp, productionCredentials, productionOrigin as origin } from '../src/lib/tests/helpers/productionHttp';
import { serveProduction } from './helpers/browserServer';

let server: Awaited<ReturnType<typeof createProductionHttp>>;

test.beforeAll(async () => { server = await createProductionHttp(); });
test.afterAll(async () => { await server?.close(); });

test('cold board loads full notes; cached refresh stays usable, reports progress and retains order', async ({ page, context }, testInfo) => {
  const source = (await readFile('src/lib/tests/fixtures/v1-card.md', 'utf8'))
    .replace('![](https://example.invalid/cover.png)\n\n', '');
  const note = (id: string, title: string) => source.replace('\ntest-card\n', `\n${id}\n`)
    .replace('# Карточка 🗂', `# ${title}`)
    .replace('2026-09-25T12:34:56.789Z', id === 'z-note' ? '2026-09-26T12:34:56.789Z' : '2026-09-25T12:34:56.789Z');
  const remote = {
    'md-cards/a-note.md': note('a-note', 'A note'),
    'md-cards/z-note.md': note('z-note', 'Z note')
  };
  await server.reset(remote);
  await serveProduction(context, server);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/login`);
  await page.getByLabel('Username', { exact: true }).fill(productionCredentials.username);
  await page.getByLabel('Password', { exact: true }).fill(productionCredentials.password);
  await page.getByLabel('Password', { exact: true }).press('Enter');
  await expect(page).toHaveURL(`${origin}/`);
  const cards = page.locator('a[data-source]');
  await expect(cards.locator('h3')).toHaveText(['Z note', 'A note']);
  await expect(page.locator('.board-progress')).toHaveCount(0);
  await expect(page.locator('.kanban-column').filter({ has: page.getByRole('heading', { name: 'В процессе (2)' }) }).locator('a[data-source]')).toHaveCount(2);

  await server.reset({
    'md-cards/z-note.md': note('z-note', 'Z updated'),
    'md-cards/a-note.md': note('a-note', 'A updated')
  });
  const listing = Promise.withResolvers<void>();
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  await page.route('**/api/cloud/files', async route => { await listing.promise; await route.fallback(); });
  await page.route('**/api/cloud/download?*', async route => {
    const filename = new URL(route.request().url()).searchParams.get('path');
    await (filename === 'z-note.md' ? first.promise : second.promise);
    await route.fallback();
  });
  try {
    await page.reload();
    await expect(cards.locator('h3')).toHaveText(['Z note', 'A note']);
    await expect(page.locator('.board-progress')).toHaveCount(0);
    await page.getByRole('button', { name: 'Обновить все заметки из облака' }).click();
    await expect(page.getByRole('status')).toHaveText('Загрузка заметок…');
    await expect(cards.locator('.card-loading')).toHaveCount(0);
    await page.locator('a[href="/card/a-note"]').click({ trial: true });
    listing.resolve();
    const progress = page.getByRole('progressbar', { name: 'Загрузка заметок' });
    await expect(progress).toHaveAttribute('value', '0');
    await expect(progress).toHaveAttribute('max', '2');
    await expect(cards.locator('h3')).toHaveText(['Z note', 'A note']);
    await expect(page.locator('a[href="/card/z-note"]')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('a[href="/card/z-note"]').getByRole('img', { name: 'Загрузка из облака' })).toBeVisible();
    await expect(page.locator('a[href="/card/a-note"]').getByRole('img', { name: 'Загрузка из облака' })).toBeVisible();
    await expect(cards.locator('.card-loading')).toHaveCount(2);
    first.resolve();
    await expect(progress).toHaveAttribute('value', '1');
    await expect(cards.locator('h3')).toHaveText(['Z updated', 'A note']);
    await expect(page.locator('a[href="/card/z-note"] .card-loading')).toHaveCount(0);
    await expect(page.locator('a[href="/card/a-note"]').getByRole('img', { name: 'Загрузка из облака' })).toBeVisible();
    await expect(cards.locator('.card-loading')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('board-progress-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('status')).toContainText('1 / 2');
    await page.locator('a[href="/card/a-note"]').click({ trial: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('board-progress-mobile.png') });
    second.resolve();
    await expect(page.locator('.board-progress')).toHaveCount(0);
    await expect(cards.locator('.card-loading')).toHaveCount(0);
    await expect(cards.locator('h3')).toHaveText(['Z updated', 'A updated']);
    expect(await cards.evaluateAll(elements => elements.map(element => element.getAttribute('href'))))
      .toEqual(['/card/z-note', '/card/a-note']);
    const response = await server.request({ url: `${origin}/api/auth/status` });
    expect(response.effects.writes).toEqual([]);
    expect(response.effects.unexpected).toEqual([]);
    expect(errors).toEqual([]);
  } finally { listing.resolve(); first.resolve(); second.resolve(); }
});

test('returning Home, reloading and opening another tab reuse the cache; manual refresh reads every note', async ({ page, context }) => {
  const source = (await readFile('src/lib/tests/fixtures/v1-card.md', 'utf8'))
    .replace('![](https://example.invalid/cover.png)\n\n', '');
  await server.reset({ 'md-cards/test-card.md': source });
  await serveProduction(context, server);
  const requests: string[] = [];
  context.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/cloud/files' || url.pathname === '/api/cloud/download') requests.push(url.pathname);
  });
  const listing = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  await page.route('**/api/cloud/files', async route => {
    started.resolve(); await listing.promise; await route.fallback();
  });
  await page.goto(`${origin}/login`);
  await page.getByLabel('Username', { exact: true }).fill(productionCredentials.username);
  await page.getByLabel('Password', { exact: true }).fill(productionCredentials.password);
  await page.getByLabel('Password', { exact: true }).press('Enter');
  await started.promise;
  const concurrent = await context.newPage();
  try {
    await concurrent.goto(origin);
    await expect(concurrent.locator('.board-progress')).toBeVisible();
    listing.resolve();
    await expect(concurrent.locator('a[data-source] h3')).toHaveText('Карточка 🗂');
    await expect(concurrent.locator('.board-progress')).toHaveCount(0);
  } finally { listing.resolve(); await concurrent.close(); }
  await expect(page.locator('a[data-source] h3')).toHaveText('Карточка 🗂');
  await expect(page.locator('.board-progress')).toHaveCount(0);
  expect(requests).toEqual(['/api/cloud/files', '/api/cloud/download']);
  await page.locator('a[href="/card/new"]').first().click();
  await expect(page.getByLabel('Название заметки')).toBeVisible();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.locator('a[data-source] h3')).toHaveText('Карточка 🗂');
  await expect(page.locator('.board-progress')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('a[data-source] h3')).toHaveText('Карточка 🗂');
  await expect(page.locator('.board-progress')).toHaveCount(0);
  const other = await context.newPage();
  await other.goto(origin);
  await expect(other.locator('a[data-source] h3')).toHaveText('Карточка 🗂');
  await expect(other.locator('.board-progress')).toHaveCount(0);
  expect(requests).toEqual(['/api/cloud/files', '/api/cloud/download']);
  await other.close();
  await page.getByRole('button', { name: 'Обновить все заметки из облака' }).click();
  await expect.poll(() => requests.length).toBe(4);
  await expect(page.locator('.board-progress')).toHaveCount(0);
  expect(requests).toEqual(['/api/cloud/files', '/api/cloud/download', '/api/cloud/files', '/api/cloud/download']);
});

test('failed note has a separate keyboard-accessible retry that reloads only that note', async ({ page, context }, testInfo) => {
  const source = (await readFile('src/lib/tests/fixtures/v1-card.md', 'utf8'))
    .replace('![](https://example.invalid/cover.png)\n\n', '');
  await server.reset({
    'md-cards/a-note.md': source.replace('\ntest-card\n', '\na-note\n').replace('Карточка 🗂', 'Recovered note'),
    'md-cards/z-note.md': source.replace('\ntest-card\n', '\nz-note\n').replace('Карточка 🗂', 'Healthy note')
  });
  await serveProduction(context, server);
  let fail = true;
  let release: Promise<void> | undefined;
  const requests = new Map<string, number>();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/cloud/download?*', async route => {
    const path = new URL(route.request().url()).searchParams.get('path')!;
    requests.set(path, (requests.get(path) ?? 0) + 1);
    if (path === 'a-note.md') {
      await release;
      if (fail) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'CLOUD_UNAVAILABLE' }) });
        return;
      }
    }
    await route.fallback();
  });
  await page.goto(`${origin}/login`);
  await page.getByLabel('Username', { exact: true }).fill(productionCredentials.username);
  await page.getByLabel('Password', { exact: true }).fill(productionCredentials.password);
  await page.getByLabel('Password', { exact: true }).press('Enter');
  await expect(page).toHaveURL(`${origin}/`);
  const retry = page.getByRole('button', { name: 'Повторить загрузку заметки «a-note»' });
  await expect(retry).toBeVisible();
  await expect(page.locator('.board-progress')).toHaveCount(0);
  await expect(page.locator('a[href="/card/z-note"] h3')).toHaveText('Healthy note');
  expect(await retry.evaluate(element => element.closest('a') === null)).toBe(true);
  await retry.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('board-error-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await retry.focus();
  await page.screenshot({ path: testInfo.outputPath('board-error-mobile.png') });
  const response = Promise.withResolvers<void>();
  release = response.promise;
  fail = false;
  try {
    await retry.press('Enter');
    await expect(page.locator('.card-load-error')).toHaveCount(0);
    await expect(page.locator('a[href="/card/a-note"]').getByRole('img', { name: 'Загрузка из облака' })).toBeVisible();
    await expect(page.locator('a[href="/card/z-note"] .card-loading')).toHaveCount(0);
    await expect(page).toHaveURL(`${origin}/`);
    response.resolve();
    await expect(page.locator('a[href="/card/a-note"] h3')).toHaveText('Recovered note');
    await expect(page.locator('.card-loading, .card-load-error')).toHaveCount(0);
    expect(Object.fromEntries(requests)).toEqual({ 'a-note.md': 2, 'z-note.md': 1 });
    expect(errors).toEqual([]);
    const result = await server.request({ url: `${origin}/api/auth/status` });
    expect(result.effects.writes).toEqual([]);
    expect(result.effects.unexpected).toEqual([]);
  } finally { response.resolve(); }
});

test('only failed cloud requests offer retry; successfully downloaded unsupported or empty notes do not', async ({ page, context }) => {
  const source = (await readFile('src/lib/tests/fixtures/v1-card.md', 'utf8'))
    .replace('![](https://example.invalid/cover.png)\n\n', '');
  await server.reset({
    'md-cards/unsupported.md': source.replace('<!-- markdown-cards: 1 -->', '<!-- markdown-cards: 2 -->'),
    'md-cards/empty.md': '',
    'md-cards/unavailable.md': source
  });
  await serveProduction(context, server);
  const requests: string[] = [];
  let fail = true;
  await page.route('**/api/cloud/download?*', async route => {
    const filename = new URL(route.request().url()).searchParams.get('path')!;
    requests.push(filename);
    if (filename === 'unavailable.md' && fail) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'CLOUD_UNAVAILABLE' }) });
      return;
    }
    await route.fallback();
  });
  await page.goto(`${origin}/login`);
  await page.getByLabel('Username', { exact: true }).fill(productionCredentials.username);
  await page.getByLabel('Password', { exact: true }).fill(productionCredentials.password);
  await page.getByLabel('Password', { exact: true }).press('Enter');
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.locator('a[data-source]')).toHaveCount(3);
  await expect(page.locator('.board-progress')).toHaveCount(0);
  const retry = page.getByRole('button', { name: 'Повторить загрузку заметки «unavailable»' });
  await expect(retry).toBeVisible();
  await expect(page.locator('.card-load-error')).toHaveCount(1);
  expect(requests.toSorted()).toEqual(['empty.md', 'unavailable.md', 'unsupported.md']);

  await page.reload();
  await expect(retry).toBeVisible();
  await expect(page.locator('.board-progress')).toHaveCount(0);
  await expect(page.locator('.card-load-error')).toHaveCount(1);
  expect(requests).toHaveLength(3);

  fail = false;
  await retry.click();
  await expect(page.locator('a[href="/card/unavailable"] h3')).toHaveText('Карточка 🗂');
  await expect(page.locator('.card-loading, .card-load-error')).toHaveCount(0);
  expect(requests).toHaveLength(4);
  expect(requests.at(-1)).toBe('unavailable.md');
  const result = await server.request({ url: `${origin}/api/auth/status` });
  expect(result.effects.writes).toEqual([]);
  expect(result.effects.unexpected).toEqual([]);
});

test('cancelled retries remain available; retries from an old tab preserve the latest shared refresh', async ({ page, context }) => {
  const source = (await readFile('src/lib/tests/fixtures/v1-card.md', 'utf8'))
    .replace('![](https://example.invalid/cover.png)\n\n', '');
  await server.reset({ 'md-cards/test-card.md': source });
  await serveProduction(context, server);
  let listings = 0;
  context.on('request', request => {
    if (new URL(request.url()).pathname === '/api/cloud/files') listings++;
  });
  let fail = true;
  let release: Promise<void> | undefined;
  await page.route('**/api/cloud/download?*', async route => {
    await release;
    if (fail) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'CLOUD_UNAVAILABLE' }) });
      return;
    }
    await route.fallback();
  });
  await page.goto(`${origin}/login`);
  await page.getByLabel('Username', { exact: true }).fill(productionCredentials.username);
  await page.getByLabel('Password', { exact: true }).fill(productionCredentials.password);
  await page.getByLabel('Password', { exact: true }).press('Enter');
  const retry = page.getByRole('button', { name: 'Повторить загрузку заметки «test-card»' });
  await expect(retry).toBeVisible();
  await expect(page.locator('.board-progress')).toHaveCount(0);
  const response = Promise.withResolvers<void>();
  release = response.promise;
  try {
    await retry.click();
    await expect(page.locator('.card-loading')).toBeVisible();
    await page.locator('a[href="/card/new"]').first().click();
    await expect(page.getByLabel('Название заметки')).toBeVisible();
    response.resolve();
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(retry).toBeVisible();
    expect(listings).toBe(1);

    await server.reset({
      'md-cards/test-card.md': source,
      'md-cards/new-note.md': source.replace('\ntest-card\n', '\nnew-note\n').replace('Карточка 🗂', 'New note')
    });
    const other = await context.newPage();
    await other.goto(origin);
    await expect(other.locator('.card-load-error')).toBeVisible();
    await expect(other.locator('.board-progress')).toHaveCount(0);
    await other.getByRole('button', { name: 'Обновить все заметки из облака' }).click();
    await expect(other.locator('a[data-source] h3')).toHaveText(['New note', 'Карточка 🗂']);
    await expect(other.locator('.board-progress')).toHaveCount(0);
    expect(listings).toBe(2);
    await other.close();

    fail = false;
    await retry.click();
    await expect(page.locator('a[href="/card/test-card"] h3')).toHaveText('Карточка 🗂');
    await expect(page.locator('.card-loading, .card-load-error')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('a[data-source] h3')).toHaveText(['New note', 'Карточка 🗂']);
    await expect(page.locator('.board-progress')).toHaveCount(0);
    expect(listings).toBe(2);
    const result = await server.request({ url: `${origin}/api/auth/status` });
    expect(result.effects.writes).toEqual([]);
    expect(result.effects.unexpected).toEqual([]);
  } finally { response.resolve(); }
});
