import { readdir, readFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('browser cloud security boundary', () => {
  it('does not expose provider credentials, configuration or direct upload methods', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_YANDEX_DISK_TOKEN', 'synthetic-client-secret');
    const { CloudService, cloudService } = await import('../services/cloudService');
    const forbidden = [
      'accessToken', 'API_BASE', 'basePath', 'setAccessToken', 'setBasePath',
      'getHeaders', 'getUploadUrl', 'uploadFile', 'uploadFileAtPath', 'checkIsAuthenticated'
    ];
    for (const service of [cloudService, new CloudService()]) {
      expect(forbidden.filter(name => name in service), 'No provider capabilities in the browser service').toEqual([]);
      expect(JSON.stringify(service)).not.toContain('synthetic-client-secret');
      expect(service.listFiles).toBeTypeOf('function');

    }
  });

  it('has no public-token gates or provider transport in browser-eligible sources, including unused diagnostics', async () => {
    const root = resolve(import.meta.dirname, '../..');
    const files: string[] = [];
    async function visit(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (['server', 'tests', 'docs'].includes(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (/\.(ts|svelte)$/.test(path) && !/(?:\.server\.ts|\+server\.ts)$/.test(path)) files.push(path);
      }
    }
    await visit(root);
    expect(files.some(path => path.endsWith('/services/cloudService.ts'))).toBe(true);
    expect(files.some(path => path.endsWith('/routes/+page.svelte'))).toBe(true);
    const forbidden = /VITE_YANDEX_DISK_(?:TOKEN|BASE_PATH)|cloud-api\.yandex\.net|OAuth\s|\.checkIsAuthenticated\(|\.setAccessToken\(|\.setBasePath\(|\.getUploadUrl\(|\.uploadFileAtPath\(|\.uploadFile\(/;
    const violations: string[] = [];
    for (const path of files) {
      (await readFile(path, 'utf8')).split('\n').forEach((line, index) => {
        if (forbidden.test(line)) violations.push(`${relative(root, path)}:${index + 1}`);
      });
    }
    expect(violations, 'Browser sources must use the session API without provider configuration').toEqual([]);
  });
});
