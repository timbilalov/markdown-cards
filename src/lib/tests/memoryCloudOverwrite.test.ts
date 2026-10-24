import { describe, expect, it } from 'vitest';
import { MemoryCloudStorage } from './helpers/memoryCloudStorage';
import type { CloudStoragePort } from '../ports/cloudStorage';

const original = { path: 'note.md', source: 'before', revision: 'base' };
const other = { path: 'other.md', source: 'keep', revision: 'other-base' };
const source = '\uFEFF# Заметка\r\nТекст 🗂  \r\n';

describe('MemoryCloudStorage.write: explicit overwrite', () => {
  it.each([true, false])('replaces an existing document with revisions=%s without conditional-create support', async revisions => {
    const storage: CloudStoragePort = new MemoryCloudStorage({
      documents: [original, other],
      capabilities: revisions
        ? { revisions: true, conditionalCreate: false }
        : { revisions: false, conditionalCreate: false }
    });
    const input = Object.freeze({ path: original.path, source });
    const result = await storage.write(input);
    expect(result).toEqual({ status: 'written', revision: revisions ? expect.any(String) : null });
    if (result.status !== 'written') throw new Error('Expected completed write');
    expect(result.revision).not.toBe('base');
    expect(await storage.read(original.path)).toEqual({ status: 'found', document: { path: original.path, source, revision: result.revision } });
    expect(await storage.read(other.path)).toEqual({ status: 'found', document: { ...other, revision: revisions ? other.revision : null } });
    expect(input).toEqual({ path: original.path, source });
  });

  it('creates a missing path with an empty source', async () => {
    const storage: CloudStoragePort = new MemoryCloudStorage();
    const result = await storage.write({ path: 'new.md', source: '' });
    expect(result).toEqual({ status: 'written', revision: expect.any(String) });
    if (result.status !== 'written') throw new Error('Expected completed write');
    expect(await storage.read('new.md')).toEqual({ status: 'found', document: { path: 'new.md', source: '', revision: result.revision } });
  });

  it('changes the revision after write and preserves create-only protection', async () => {
    const storage: CloudStoragePort = new MemoryCloudStorage({ documents: [original] });
    const result = await storage.write({ path: original.path, source });
    expect(result).toEqual({ status: 'written', revision: expect.any(String) });
    if (result.status !== 'written') throw new Error('Expected completed write');
    expect(result.revision).not.toBe(original.revision);

    expect(await storage.write({ ...original, createOnly: true })).toEqual({ status: 'conflict' });
    expect(await storage.read(original.path)).toEqual({ status: 'found', document: { path: original.path, source, revision: result.revision } });
  });
  it('accepts explicit createOnly false as ordinary write', async () => {
    const storage: CloudStoragePort = new MemoryCloudStorage();
    expect(await storage.write({ path: 'note.md', source: '', createOnly: false }))
      .toEqual({ status: 'written', revision: expect.any(String) });
  });

  it.each([null, 'true', 'false', 0, 1])('rejects invalid createOnly %j without effects', async createOnly => {
    const storage: CloudStoragePort = new MemoryCloudStorage();
    expect(await storage.write({ path: 'note.md', source: '', createOnly: createOnly as unknown as boolean }))
      .toEqual({ status: 'invalid', reason: 'invalid-create-only' });
    expect(await storage.list()).toEqual({ status: 'success', entries: [] });
  });

});
