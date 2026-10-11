// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { YandexDiskAdapter } from '../server/cloud/yandexDiskAdapter';
import { mockHttp } from './helpers/http';
import {
  diskPage, diskResource, listResponseUrl, padResponse, phaseFailure, phaseSuccess, phaseText,
  responseBudgets, responseBytes, responsePhases, responseRoot, setupResponsePhase, streamedResponse
} from './helpers/cloudResponseFixtures';

let http: ReturnType<typeof mockHttp>;
beforeEach(() => { http = mockHttp(); });
afterEach(() => { http.assertHandled(); });

describe.each(responsePhases)('$name: bounded provider response body', ({ kind, budget }) => {
  it.each(['absent', 'understated'] as const)('counts actual bytes with %s Content-Length, cancels and allows an exact-limit retry', async header => {
    const bytes = padResponse(phaseText(kind), budget + 1);
    const stream = streamedResponse([bytes.subarray(0, 7), bytes.subarray(7), responseBytes(' ')],
      header === 'understated' ? { 'Content-Length': '1' } : undefined);
    const invoke = setupResponsePhase(http, kind, () => stream.response);

    // Check the result without printing a megabyte of source on RED failure.
    const result = await invoke();
    expect(result.status).toBe('unavailable');
    expect(result).toEqual(phaseFailure(kind));
    expect(stream.pull).toHaveBeenCalledTimes(2);
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.response.body?.locked).toBe(false);
    const refusalCalls = http.fetch.mock.calls.length;
    expect(refusalCalls).toBe(kind === 'redirect-source' ? 3 : kind === 'source' ? 2 : 1);

    const exact = padResponse(phaseText(kind), budget);
    // Split every initial Unicode character across byte boundaries.
    const retry = streamedResponse([...exact.subarray(0, 200)].map(byte => new Uint8Array([byte]))
      .concat([exact.subarray(200)]));
    const retryInvoke = setupResponsePhase(http, kind, () => retry.response);
    const expectedSource = new TextDecoder('utf-8', { ignoreBOM: true }).decode(exact);
    expect(await retryInvoke()).toEqual(phaseSuccess(kind,
      kind === 'source' || kind === 'redirect-source' ? expectedSource : undefined));
    expect(retry.cancel).not.toHaveBeenCalled();
    expect(retry.response.body?.locked).toBe(false);
  });

  it('refuses an oversized declared length before pulling any body chunk', async () => {
    const stream = streamedResponse([responseBytes(phaseText(kind))], { 'Content-Length': String(budget + 1) });
    const invoke = setupResponsePhase(http, kind, () => stream.response);
    const result = await invoke();
    expect(result.status).toBe('unavailable');
    expect(result).toEqual(phaseFailure(kind));
    expect(stream.pull).not.toHaveBeenCalled();
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.response.body?.locked).toBe(false);
  });
});

describe('bounded reader cleanup', () => {
  it.each(['reject', 'pending'] as const)('returns the refusal even when stream cancellation is %s', async cancellation => {
    const stream = streamedResponse([padResponse(phaseText('read-link'), responseBudgets.link + 1), responseBytes(' ')],
      undefined, cancellation);
    const invoke = setupResponsePhase(http, 'read-link', () => stream.response);
    expect(await invoke()).toEqual(phaseFailure('read-link'));
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.pull).toHaveBeenCalledTimes(1);
    expect(stream.response.body?.locked).toBe(false);
  });
});

describe('complete listing budgets include filtered resources and provider-only fields', () => {
  it.each(['known', 'unknown'] as const)('stops before page 101 with %s total, discards the partial list and permits a fresh exact-boundary list', async totalKind => {
    const adapter = new YandexDiskAdapter({ accessToken: 'test-token', rootPath: responseRoot, pageSize: 1 });
    for (let offset = 0; offset <= 100; offset++) {
      const items = offset === 100 && totalKind === 'unknown' ? []
        : [diskResource(`note-${offset}.${offset % 2 === 0 ? 'md' : 'txt'}`)];
      const page = diskPage(items, offset, 101, 1);
      if (totalKind === 'unknown') delete (page._embedded as { total?: number }).total;
      http.on('GET', listResponseUrl(offset, 1), () => Response.json(page));
    }

    const result = await adapter.list();
    expect(result.status).toBe('unavailable');
    expect(result).toEqual(phaseFailure('list'));
    expect(http.fetch.mock.calls.length).toBeLessThanOrEqual(responseBudgets.pages);
    expect(http.fetch.mock.calls.some(([url]) => String(url) === listResponseUrl(100, 1))).toBe(false);

    http.fetch.mockClear();
    const expected = [];
    for (let offset = 0; offset < 100; offset++) {
      const name = `recovered-${offset}.md`;
      const items = offset === 99 && totalKind === 'unknown' ? [] : [diskResource(name)];
      const page = diskPage(items, offset, 100, 1);
      if (totalKind === 'unknown') delete (page._embedded as { total?: number }).total;
      http.on('GET', listResponseUrl(offset, 1), () => Response.json(page));
      if (items.length) expected.push({ path: name, revision: null });
    }
    expect(await adapter.list()).toEqual({ status: 'success', entries: expected });
    expect(http.fetch).toHaveBeenCalledTimes(100);
  });

  it('stops before another request when eight MiB are exhausted and accepts a complete list at exactly eight MiB', async () => {
    const adapter = new YandexDiskAdapter({ accessToken: 'test-token', rootPath: responseRoot, pageSize: 1 });
    const register = (total: number) => {
      for (let offset = 0; offset < total; offset++) {
        const page = diskPage([diskResource(`file-${offset}.md`)], offset, total, 1);
        http.on('GET', listResponseUrl(offset, 1), () => new Response(padResponse(JSON.stringify(page), responseBudgets.page)));
      }
    };
    register(9);
    expect(await adapter.list()).toEqual(phaseFailure('list'));
    expect(http.fetch).toHaveBeenCalledTimes(8);
    register(8);
    http.fetch.mockClear();
    expect(await adapter.list()).toEqual({ status: 'success', entries: Array.from({ length: 8 }, (_, offset) => ({
      path: `file-${offset}.md`, revision: null
    })) });
    expect(http.fetch).toHaveBeenCalledTimes(8);
  });

  it('applies the remaining aggregate bytes while streaming a later page, even when each page is below its own cap', async () => {
    const adapter = new YandexDiskAdapter({ accessToken: 'test-token', rootPath: responseRoot, pageSize: 1 });
    for (let offset = 0; offset < 8; offset++) {
      const page = diskPage([diskResource(`folder-${offset}`, 'dir')], offset, 9, 1);
      const size = responseBudgets.page - (offset === 7 ? 1024 : 0);
      http.on('GET', listResponseUrl(offset, 1), () => new Response(padResponse(JSON.stringify(page), size)));
    }
    const lastPage = diskPage([diskResource('last.md')], 8, 9, 1);
    const stream = streamedResponse([padResponse(JSON.stringify(lastPage), 1025), responseBytes(' ')]);
    http.on('GET', listResponseUrl(8, 1), () => stream.response);
    expect(await adapter.list()).toEqual(phaseFailure('list'));
    expect(http.fetch).toHaveBeenCalledTimes(9);
    expect(stream.pull).toHaveBeenCalledTimes(1);
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.response.body?.locked).toBe(false);
  });
});
