import { expect } from 'vitest';

// Expectations are independent of production policy/configuration.
export const requiredSecurityHeaders = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()'
};
export const hsts = 'max-age=31536000; includeSubDomains';

export function parseCsp(value: string | null | undefined): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const directive of (value ?? '').split(';')) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (!name) continue;
    // Multiple policies or repeated directives must not hide a weaker policy.
    expect.soft(name.includes(',')).toBe(false);
    expect.soft(result.has(name), `Repeated CSP directive ${name}`).toBe(false);
    result.set(name, sources);
  }
  return result;
}

// Soft policy assertions let existing status/body/retry checks execute on RED,
// so a fixture error cannot stay hidden behind the first missing header.
export function expectSecurityHeaders(headers: Headers, secure = true): void {
  for (const [name, value] of Object.entries(requiredSecurityHeaders)) {
    expect.soft(headers.get(name), name).toBe(value);
  }
  expect.soft(headers.has('X-XSS-Protection')).toBe(false);
  expect.soft(headers.get('Strict-Transport-Security')).toBe(secure ? hsts : null);
}

export function expectFallbackCsp(headers: Headers): void {
  const policy = parseCsp(headers.get('Content-Security-Policy'));
  for (const name of ['default-src', 'base-uri', 'object-src', 'frame-ancestors']) {
    expect.soft(policy.get(name), name).toEqual(["'none'"]);
  }
  expect.soft(policy.get('form-action')).toEqual(["'self'"]);
}

export function expectPageCsp(headers: Headers): Map<string, string[]> {
  const policy = parseCsp(headers.get('Content-Security-Policy'));
  for (const name of ['default-src', 'connect-src', 'font-src', 'form-action']) {
    expect.soft(policy.get(name), name).toEqual(["'self'"]);
  }
  for (const name of ['base-uri', 'object-src', 'frame-src', 'frame-ancestors', 'script-src-attr']) {
    expect.soft(policy.get(name), name).toEqual(["'none'"]);
  }
  expect.soft(policy.get('style-src-attr')).toEqual(["'unsafe-hashes'", "'sha256-S8qMpvofolR8Mpjy4kQvEm7m1q8clzU4dfDH0AmvZjo='"]);
  expect.soft([...(policy.get('img-src') ?? [])].sort()).toEqual(["'self'", 'data:', 'http:', 'https:'].sort());
  for (const name of ['script-src', 'style-src']) {
    const sources = policy.get(name) ?? [];
    expect.soft(sources, name).toContain("'self'");
    expect.soft(sources.filter(source => source !== "'self'" && !/^'(nonce|sha256|sha384|sha512)-[^']+'$/.test(source)), name).toEqual([]);
  }
  expect.soft(headers.has('Content-Security-Policy-Report-Only')).toBe(false);
  return policy;
}
