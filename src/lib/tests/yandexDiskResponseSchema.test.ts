// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockHttp } from './helpers/http';
import {
  diskPage, diskResource, downloadHref, downloadLink, phaseFailure, phaseSuccess, phaseText,
  responseBytes, responsePhases, setupResponsePhase, streamedResponse, uploadHref, uploadLink
} from './helpers/cloudResponseFixtures';

let http: ReturnType<typeof mockHttp>;
beforeEach(() => { http = mockHttp(); });
afterEach(() => { http.assertHandled(); });
const jsonPhases = responsePhases.filter(({ kind }) => kind !== 'source' && kind !== 'redirect-source');

describe.each(jsonPhases)('$name: unambiguous provider JSON', ({ kind }) => {
  async function expectRefusalAndRecovery(bytes: Uint8Array<ArrayBuffer>) {
    const invoke = setupResponsePhase(http, kind, () => new Response(bytes));
    const result = await invoke();
    expect(result.status).toBe('unavailable');
    expect(result).toEqual(phaseFailure(kind));
    expect(http.fetch).toHaveBeenCalledTimes(1);

    // Valid unknown fields, strings that resemble JSON keys, paired Unicode,
    // literal replacement characters and the existing JSON BOM behavior survive.
    const valid = JSON.parse(phaseText(kind));
    valid.extra = { nested: [{ same: 'first' }, { same: 'second' }],
      punctuation: '"href":"other", "method":"POST"', unicode: '😀 e\u0301 �' };
    const raw = responseBytes('\uFEFF' + JSON.stringify(valid));
    const stream = streamedResponse([...raw].map(byte => new Uint8Array([byte])));
    const retry = setupResponsePhase(http, kind, () => stream.response);
    expect(await retry()).toEqual(phaseSuccess(kind));
    expect(stream.cancel).not.toHaveBeenCalled();
  }

  it.each([
    ['invalid leading byte', [0xff]],
    ['encoded surrogate', [0xed, 0xa0, 0x80]]
  ] as const)('rejects %s even inside ignored provider metadata', async (_name, invalid) => {
    const text = phaseText(kind);
    const prefix = responseBytes('{"ignored":"');
    const suffix = responseBytes('",' + text.slice(1));
    const bytes = new Uint8Array(prefix.length + invalid.length + suffix.length);
    bytes.set(prefix);
    bytes.set(invalid, prefix.length);
    bytes.set(suffix, prefix.length + invalid.length);
    await expectRefusalAndRecovery(bytes);
  });

  it.each(['identical', 'conflicting', 'escaped'] as const)('rejects %s duplicate top-level keys instead of selecting the last value', async mode => {
    const text = phaseText(kind);
    const key = kind === 'list' ? 'type' : 'method';
    const value = JSON.parse(text)[key];
    const wireKey = mode === 'escaped' ? `\\u${key.charCodeAt(0).toString(16).padStart(4, '0')}${key.slice(1)}` : key;
    const firstValue = mode === 'conflicting' ? 'wrong-first-value' : value;
    await expectRefusalAndRecovery(responseBytes(`{ "${wireKey}" : ${JSON.stringify(firstValue)}, ${text.slice(1)}`));
  });

  it('rejects duplicate keys inside a nested object but not equal names in different objects', async () => {
    const text = phaseText(kind);
    await expectRefusalAndRecovery(responseBytes('{"extra":{"nested":[{"field":1,"fi\\u0065ld":2}]},' + text.slice(1)));
  });
});

describe('listing schema: nested ambiguity and well-formed resource names', () => {
  it.each(['pagination', 'resource'] as const)('rejects duplicate %s fields before returning a successful list', async location => {
    const page = JSON.stringify(diskPage());
    const body = location === 'pagination' ? page.replace('"items":', '"total":999,"items":')
      : page.replace('"name":', '"name":"wrong-first.md","name":');
    const invoke = setupResponsePhase(http, 'list', () => new Response(body));
    expect(await invoke()).toEqual(phaseFailure('list'));
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['\uD800', '\uDC00'])('refuses an unpaired surrogate %j in matching name/path fields without normalizing it', async surrogate => {
    const invoke = setupResponsePhase(http, 'list', () => Response.json(diskPage([diskResource(`${surrogate}.md`)])));
    expect(await invoke()).toEqual(phaseFailure('list'));
    expect(http.fetch).toHaveBeenCalledTimes(1);
    const retry = setupResponsePhase(http, 'list', () => Response.json(diskPage([diskResource('😀�.md')])));
    expect(await retry()).toEqual({ status: 'success', entries: [{ path: '😀�.md', revision: null }] });
  });
});

describe.each(['read-link', 'write-link', 'create-link'] as const)('%s: signed URL is not repaired by URL parsing', kind => {
  it.each(['\uD800', '\uDC00'])('rejects the unpaired surrogate %j before following the link', async surrogate => {
    const link = kind === 'read-link' ? downloadLink : uploadLink;
    const href = (kind === 'read-link' ? downloadHref : uploadHref) + surrogate;
    const invoke = setupResponsePhase(http, kind, () => Response.json({ ...link, href }), href);
    expect(await invoke()).toEqual(phaseFailure(kind));
    expect(http.fetch).toHaveBeenCalledTimes(1);
    const retry = setupResponsePhase(http, kind, () => Response.json(link));
    expect(await retry()).toEqual(phaseSuccess(kind));
  });
});
