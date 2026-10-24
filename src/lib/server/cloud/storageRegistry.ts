import { createHash } from 'node:crypto';
import { checkIsRegistryId, checkIsIdentityText } from '../../utils/storageValidation';
import type {
  CloudStorageCapabilities,
  CloudStoragePort,
  CloudUnavailable
} from '../../ports/cloudStorage';

// Supplied by server-side provider resolution, not by a browser request. The
// account ID must be verified against the provider connection. rootId is the
// provider's canonical root identity, including namespace/app scope when needed;
// the registry neither normalizes paths nor guesses an account from a token.
export interface StorageTargetIdentity {
  provider: string;
  accountId: string;
  rootId: string;
}

export type StorageIdentityResult =
  { status: 'success'; identity: StorageTargetIdentity } | CloudUnavailable;

export interface IdentifiedStoragePort extends CloudStoragePort {
  identify(): Promise<StorageIdentityResult>;
}

export interface StorageDescriptor {
  id: string;
  label: string;
  provider: string;
  contextId: string;
  // Display metadata, absent for historical connections. Never an identity key.
  rootPath?: string;
  capabilities: CloudStorageCapabilities;
}

const configurationError = 'Invalid storage registry configuration';

// All invalid configuration errors use exactly
// "Invalid storage registry configuration" without embedding supplied values.
// IDs/provider keys are nonempty ASCII letters/digits/_/-, case-sensitive.
// Other identity strings are nonblank, well-formed and free of control chars;
// they are opaque and must not be trimmed, case-folded or inferred from labels.
// The versioned opaque ID binds the configured instance ID AND all target fields.
// ctx-v1 is SHA-256 of UTF-8 JSON.stringify([
//   'markdown-cards-storage-context', 1, storageId, provider, accountId, rootId
// ]), prefixed with 'ctx-v1-'. This encoding is persisted identity: a future
// encoding change requires an explicit version/migration, not silent rekeying.
export function createStorageContextId(
  storageId: string,
  target: Readonly<StorageTargetIdentity>
): string {
  if (
    !checkIsRegistryId(storageId) ||
    !checkIsRegistryId(target?.provider) ||
    !checkIsIdentityText(target?.accountId) ||
    !checkIsIdentityText(target?.rootId)
  ) {
    throw new Error(configurationError);
  }
  const encoded = JSON.stringify([
    'markdown-cards-storage-context',
    1,
    storageId,
    target.provider,
    target.accountId,
    target.rootId
  ]);
  return `ctx-v1-${createHash('sha256').update(encoded, 'utf8').digest('hex')}`;
}

// Explicit whitelist shared by both public catalogs and captured descriptors.
export function describeStorageDescriptor(descriptor: StorageDescriptor): StorageDescriptor {
  const { id, label, provider, contextId, rootPath, capabilities } = descriptor;
  return {
    id,
    label,
    provider,
    contextId,
    ...(rootPath === undefined ? {} : { rootPath }),
    capabilities: {
      revisions: capabilities.revisions,
      conditionalCreate: capabilities.conditionalCreate,
      ...(capabilities.conditionalUpdate === undefined
        ? {}
        : { conditionalUpdate: capabilities.conditionalUpdate }),
      ...(capabilities.caseSensitivePaths === undefined
        ? {}
        : { caseSensitivePaths: capabilities.caseSensitivePaths })
    }
  };
}
