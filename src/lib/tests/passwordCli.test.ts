// @vitest-environment node
import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { compare } from 'bcryptjs';
import { loadEnv } from 'vite';
it('prints usable credentials without appending or replacing an existing .env', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'markdown-cards-password-'));
  const original = 'ADMIN_USERNAME=existing\nSESSION_SECRET=fixture-only\n';
  try {
    await writeFile(join(directory, '.env'), original);
    const { stdout } = await promisify(execFile)(process.execPath,
      [resolve('scripts/generatePasswordHash.ts')], { cwd: directory });
    expect(await readFile(join(directory, '.env'), 'utf8')).toBe(original);
    const password = stdout.match(/^Password: (.+)$/m)?.[1];
    const hash = stdout.match(/^ADMIN_PASSWORD_HASH=(.+)$/m)?.[1];
    expect(password).toBeTruthy();
    expect(hash).toBeTruthy();
    expect(await compare(password!, hash!)).toBe(true);
    const local = stdout.match(/^Local \.env: ADMIN_PASSWORD_HASH=(.+)$/m)?.[1];
    expect(local).toBeTruthy();
    await writeFile(join(directory, '.env'), `CLI_HASH_FIXTURE=${local}\n`);
    expect(loadEnv('development', directory, 'CLI_HASH_FIXTURE').CLI_HASH_FIXTURE).toBe(hash);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
