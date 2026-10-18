// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDeploymentAdapter } from '../../../config/deploymentAdapters.js';

describe('deployment adapter selection', () => {
  it.each([
    [{}, '@sveltejs/adapter-vercel'],
    [{ VERCEL: '1' }, '@sveltejs/adapter-vercel'],
    [{ NETLIFY: 'true' }, '@sveltejs/adapter-netlify'],
    [{ NETLIFY: 'false' }, '@sveltejs/adapter-vercel']
  ])('selects the adapter for %j', (environment, name) => {
    expect(createDeploymentAdapter(environment).name).toBe(name);
  });

  it.each([
    ['vercel', '@sveltejs/adapter-vercel'],
    ['netlify', '@sveltejs/adapter-netlify']
  ])('lets explicit %s override conflicting platform metadata', (target, name) => {
    expect(createDeploymentAdapter({ DEPLOY_TARGET: target, VERCEL: '1', NETLIFY: 'true' }).name).toBe(name);
  });

  it.each(['unknown', '', 'constructor', 'toString'])('rejects unsupported target %j instead of silently building for another host', target => {
    expect(() => createDeploymentAdapter({ DEPLOY_TARGET: target, NETLIFY: 'true' }))
      .toThrow(/Unknown DEPLOY_TARGET.*Supported targets: vercel, netlify/);
  });

  it('requires an explicit target when platform metadata is ambiguous', () => {
    expect(() => createDeploymentAdapter({ VERCEL: '1', NETLIFY: 'true' }))
      .toThrow(/Multiple deployment platforms detected.*Set DEPLOY_TARGET explicitly/);
  });
});
