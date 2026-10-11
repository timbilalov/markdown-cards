// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProductionHttp, readAuthCookie, type ProductionResponse } from './helpers/productionHttp';
import { invalidLoginBytes, invalidLoginFields, loginCredentials, loginOrigin as origin } from './helpers/loginInputFixtures';

let server: Awaited<ReturnType<typeof createProductionHttp>> | undefined;
beforeAll(async () => { server = await createProductionHttp(); }, 90_000);
afterAll(async () => { await server?.close(); });

function expectRefusal(response: ProductionResponse) {
  expect(response.status).toBe(400);
  expect(response.headers['content-type']).toContain('application/json');
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.headers.location).toBeUndefined();
  expect(JSON.parse(response.text)).toEqual({ message: 'Invalid login request.' });
  expect(response.cookies).toEqual([]);
  expect(response.effects).toEqual({ requests: [], writes: [], remote: {}, unexpected: [], databaseOpens: 0 });
}

async function recovery() {
  for (const rememberMe of [false, true]) {
    const response = await server!.request({ url: `${origin}/api/auth/login`, method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...loginCredentials, rememberMe }) });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const cookie = readAuthCookie(response);
    const authHeader = response.cookies.find(value => value.startsWith('auth_token='))!;
    expect(authHeader).toContain('HttpOnly');
    expect(authHeader).toContain('Secure');
    expect(authHeader).toContain('SameSite=Strict');
    expect(/Expires=/i.test(authHeader)).toBe(rememberMe);
    const status = await server!.request({ url: `${origin}/api/auth/status`, headers: { Cookie: cookie } });
    expect(status.status).toBe(200);
    expect(JSON.parse(status.text)).toEqual({ authenticated: true, username: loginCredentials.username });
    expect(status.effects).toEqual({ requests: [], writes: [], remote: {}, unexpected: [], databaseOpens: 0 });
  }
}

const names = [
  'extra role', 'prototype key', 'extra field before missing credentials',
  'duplicate username with valid last value', 'duplicate identical password',
  'escaped duplicate rememberMe', 'leading username whitespace', '257-unit username',
  'lone high surrogate in password'
];

describe('strict login schema through the generated production entry', () => {
  it.each(invalidLoginFields.filter(scenario => names.includes(scenario.name)))
    ('refuses $name without a session and allows normal/remembered login afterward', async ({ body }) => {
      const response = await server!.request({ url: `${origin}/api/auth/login`, method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' }, body });
      expectRefusal(response);
      await recovery();
    });

  it.each(invalidLoginBytes)('refuses $name without replacement decoding', async ({ bytes }) => {
    const response = await server!.request({ url: `${origin}/api/auth/login`, method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' }, bodyBytes: bytes });
    expectRefusal(response);
    await recovery();
  });
});
