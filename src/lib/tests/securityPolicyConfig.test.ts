// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('keeps security headers out of HTML meta and duplicate deployment rules, with no external shell dependencies', async () => {
  const root = resolve(import.meta.dirname, '../../..');
  const [template, vercel] = await Promise.all([
    readFile(resolve(root, 'src/app.html'), 'utf8'), readFile(resolve(root, 'vercel.json'), 'utf8')
  ]);
  const document = new DOMParser().parseFromString(template, 'text/html');
  const owned = ['x-content-type-options', 'x-frame-options', 'x-xss-protection', 'strict-transport-security',
    'referrer-policy', 'permissions-policy', 'content-security-policy'];
  const meta = [...document.querySelectorAll('meta[http-equiv]')].map(element => element.getAttribute('http-equiv')!.toLowerCase());
  expect.soft(meta.filter(name => owned.includes(name))).toEqual([]);
  const configuration = JSON.parse(vercel) as { headers?: { headers: { key: string; value: string }[] }[] };
  expect.soft((configuration.headers ?? []).flatMap(rule => rule.headers).filter(header => owned.includes(header.key.toLowerCase()))).toEqual([]);
  const external = [...document.querySelectorAll('script[src],link[rel="stylesheet"]')]
    .map(element => element.getAttribute('src') ?? element.getAttribute('href')!)
    .filter(url => new URL(url, 'https://app.example.invalid').origin !== 'https://app.example.invalid');
  expect.soft(external).toEqual([]);
});
