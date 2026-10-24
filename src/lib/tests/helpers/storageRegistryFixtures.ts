import type { StorageDescriptor, StorageTargetIdentity } from '../../server/cloud/storageRegistry';

export const TARGET: StorageTargetIdentity = {
  provider: 'provider-a',
  accountId: 'verified-account-a',
  rootId: 'namespace-a:/notes'
};

export function descriptor(id: string): StorageDescriptor {
  return {
    id,
    label: `Storage ${id}`,
    provider: 'provider-a',
    contextId: `ctx-v1-${'a'.repeat(64)}`,
    capabilities: { revisions: true, conditionalCreate: true }
  };
}
