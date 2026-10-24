// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { MemoryCloudStorage } from './helpers/memoryCloudStorage';
import { describeConnections, type StorageConnections } from '../server/cloud/storageConnections';
import { parseStorageCatalog } from '../services/storageCatalog';
import { descriptor } from './helpers/storageRegistryFixtures';

function fixture(): StorageConnections {
  return {
    activeStorageId: 'backup',
    storages: ['primary', 'backup', 'third'].map((id, index) => ({
      id,
      label: `Storage ${id}`,
      provider: 'provider-a',
      descriptor: {
        ...descriptor(id),
        contextId: `ctx-v1-${['a', 'b', 'c'][index].repeat(64)}`,
        capabilities: {
          revisions: true,
          conditionalCreate: true,
          conditionalUpdate: true,
          caseSensitivePaths: false
        }
      },
      storage: Object.assign(new MemoryCloudStorage(), {
        identify: vi.fn(),
        accessToken: `private-${id}-token`,
        refreshToken: `private-${id}-refresh`,
        accountId: 'private-account-marker',
        rootPath: '/private-root-marker'
      })
    }))
  };
}

function expectedCatalog() {
  return {
    activeStorageId: 'backup',
    storages: ['primary', 'backup', 'third'].map((id, index) => ({
      id,
      label: `Storage ${id}`,
      provider: 'provider-a',
      status: 'available',
      contextId: `ctx-v1-${['a', 'b', 'c'][index].repeat(64)}`,
      capabilities: {
        revisions: true,
        conditionalCreate: true,
        conditionalUpdate: true,
        caseSensitivePaths: false
      }
    }))
  };
}

describe('storage catalog: explicit public metadata without provider connection state', () => {
  it('exposes only configured descriptors, the active ID and capabilities in connection order', () => {
    const result = describeConnections(fixture());
    expect(result).toEqual(expectedCatalog());
    expect(parseStorageCatalog(JSON.parse(JSON.stringify(result)))).toEqual(expectedCatalog());
  });

  it('returns detached descriptors and capabilities rather than exposing connection-owned objects', () => {
    const registry = fixture();
    const result = describeConnections(registry);
    expect(result).toEqual(expectedCatalog());
    result.activeStorageId = 'only-returned-active';
    result.storages[0].label = 'Only returned label';
    const first = result.storages[0];
    if (first.status !== 'available') throw new Error('Expected a verified descriptor');
    first.capabilities.conditionalCreate = false;
    result.storages.reverse();
    expect(describeConnections(registry)).toEqual(expectedCatalog());
  });

  it('retains its captured metadata when the connections are later changed', () => {
    const registry = fixture();
    const result = describeConnections(registry);
    expect(result).toEqual(expectedCatalog());
    registry.activeStorageId = 'third';
    const entry = registry.storages.find(entry => entry.id === 'primary');
    if (!entry) throw new Error('Broken independent fixture');
    entry.descriptor!.label = 'Later registry label';
    entry.descriptor!.capabilities.revisions = false;
    expect(result).toEqual(expectedCatalog());
  });
});
