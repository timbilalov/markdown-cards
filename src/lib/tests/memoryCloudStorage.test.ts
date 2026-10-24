// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MemoryCloudStorage } from './helpers/memoryCloudStorage';
import type { CloudStorageCapabilities } from '../ports/cloudStorage';
import { defineCloudStorageContract } from './contracts/cloudStorage.contract';

const fullCapabilities: CloudStorageCapabilities = {
  revisions: true, conditionalCreate: true
};

defineCloudStorageContract({
  name: 'MemoryCloudStorage',
  capabilities: fullCapabilities,
  create: documents => new MemoryCloudStorage({ documents })
});

describe('MemoryCloudStorage: configurable provider capabilities', () => {
  const limitedProfiles: CloudStorageCapabilities[] = [
    { revisions: true, conditionalCreate: true },
    { revisions: false, conditionalCreate: true },
    { revisions: false, conditionalCreate: false }
  ];

  it.each(limitedProfiles)('reports explicitly configured capabilities %j', capabilities => {
    expect(new MemoryCloudStorage({ capabilities }).getCapabilities()).toEqual(capabilities);
  });

  it('does not create even a missing file when conditional creation is unavailable', async () => {
    const port = new MemoryCloudStorage({ capabilities: limitedProfiles[2] });
    expect(await port.write({ path: 'note.md', source: 'new', createOnly: true }))
      .toEqual({ status: 'unsupported', operation: 'create-only' });
    expect(await port.list()).toEqual({ status: 'success', entries: [] });
  });

  it('reports unknown revisions consistently instead of inventing a match token', async () => {
    const port = new MemoryCloudStorage({ capabilities: limitedProfiles[1] });
    expect(await port.write({ path: 'note.md', source: '', createOnly: true }))
      .toEqual({ status: 'written', revision: null });
    expect(await port.read('note.md')).toEqual({
      status: 'found', document: { path: 'note.md', source: '', revision: null }
    });
    expect(await port.list()).toEqual({ status: 'success', entries: [{ path: 'note.md', revision: null }] });

  });
});
