// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createStorageContextId } from '../server/cloud/storageRegistry';
import type { StorageTargetIdentity } from '../server/cloud/storageRegistry';
import { TARGET } from './helpers/storageRegistryFixtures';

const contextPattern = /^ctx-v1-[a-f0-9]{64}$/;
const configurationError = /^Invalid storage registry configuration$/;

describe('storage context identity: a stable destination rather than credentials or a label', () => {
  // Independent golden vectors: literal outputs were calculated from the
  // documented JSON tuple with Python hashlib, not the production function.
  it.each([
    {
      target: TARGET,
      expected: 'ctx-v1-ef8a596fe70ef9b22329c565a974eda877a2111edc5bd8785ceebb36cee9e915'
    },
    {
      target: {
        provider: 'provider-a',
        accountId: 'verified-account-✓',
        rootId: 'namespace:/Заметки 🗂'
      },
      expected: 'ctx-v1-dfbc132dd19228ae7e62b076f9e8735773ccdb867d6d7fac48e3eb6205708a00'
    }
  ])(
    'preserves the persisted ctx-v1 encoding for $target.rootId across application versions',
    ({ target, expected }) => {
      expect(createStorageContextId('primary', target)).toEqual(expected);
    }
  );

  it('returns a deterministic versioned opaque ID for a fully specified instance and target', () => {
    const first = createStorageContextId('primary', TARGET);
    expect(first).toEqual(expect.stringMatching(contextPattern));
    expect(
      createStorageContextId('primary', {
        rootId: TARGET.rootId,
        accountId: TARGET.accountId,
        provider: TARGET.provider
      })
    ).toBe(first);
  });

  it.each([
    { field: 'provider', value: 'provider-b' },
    { field: 'accountId', value: 'verified-account-b' },
    { field: 'rootId', value: 'namespace-a:/other-notes' },
    { field: 'rootId', value: 'namespace-b:/notes' }
  ] as const)('changes context when $field becomes $value', ({ field, value }) => {
    const first = createStorageContextId('primary', TARGET);
    expect(first).toEqual(expect.stringMatching(contextPattern));
    const changed = createStorageContextId('primary', { ...TARGET, [field]: value });
    expect(changed).toEqual(expect.stringMatching(contextPattern));
    expect(changed).not.toBe(first);
  });

  it('changes context when a new configured instance ID replaces an old one', () => {
    const first = createStorageContextId('primary', TARGET);
    expect(first).toEqual(expect.stringMatching(contextPattern));
    const renamed = createStorageContextId('another-instance', TARGET);
    expect(renamed).toEqual(expect.stringMatching(contextPattern));
    expect(renamed).not.toBe(first);
  });

  it('does not silently equate differently cased canonical roots', () => {
    const first = createStorageContextId('primary', { ...TARGET, rootId: 'namespace-a:/Notes' });
    expect(first).toEqual(expect.stringMatching(contextPattern));
    expect(createStorageContextId('primary', { ...TARGET, rootId: 'namespace-a:/notes' })).not.toBe(
      first
    );
  });

  it('preserves a significant trailing space in an opaque canonical root rather than trimming it', () => {
    const first = createStorageContextId('primary', TARGET);
    expect(first).toEqual(expect.stringMatching(contextPattern));
    const withSpace = createStorageContextId('primary', { ...TARGET, rootId: TARGET.rootId + ' ' });
    expect(withSpace).toEqual(expect.stringMatching(contextPattern));
    expect(withSpace).not.toBe(first);
  });

  it('encodes target fields unambiguously even when identifiers contain a separator', () => {
    const first = createStorageContextId('primary', {
      ...TARGET,
      accountId: 'account|part',
      rootId: 'folder'
    });
    expect(first).toEqual(expect.stringMatching(contextPattern));
    const second = createStorageContextId('primary', {
      ...TARGET,
      accountId: 'account',
      rootId: 'part|folder'
    });
    expect(second).toEqual(expect.stringMatching(contextPattern));
    expect(second).not.toBe(first);
  });

  it('accepts an opaque canonical root for an app folder without needing an ordinary nonempty path', () => {
    expect(createStorageContextId('primary', { ...TARGET, rootId: 'app-scope:app-123:/' })).toEqual(
      expect.stringMatching(contextPattern)
    );
  });

  it('does not include plaintext account or root values in the public context ID', () => {
    const target = {
      ...TARGET,
      accountId: 'private-account-marker',
      rootId: 'namespace:/private-root-marker'
    };
    const result = createStorageContextId('primary', target);
    expect(result).toEqual(expect.stringMatching(contextPattern));
    expect(result).not.toContain('private-account-marker');
    expect(result).not.toContain('private-root-marker');
  });

  it('does not mutate a frozen resolved target', () => {
    const target = Object.freeze({ ...TARGET });
    const result = createStorageContextId('primary', target);
    expect(result).toEqual(expect.stringMatching(contextPattern));
    expect(target).toEqual(TARGET);
  });

  it.each(['', ' ', 'with/slash', 'with:colon', 'with\nnewline', '\uD800'])(
    'rejects invalid configured instance ID %j without exposing it',
    id => {
      expect(() => createStorageContextId(id, TARGET)).toThrow(configurationError);
    }
  );

  it.each([
    { field: 'provider', value: '' },
    { field: 'provider', value: 'provider with space' },
    { field: 'accountId', value: '' },
    { field: 'accountId', value: ' \t' },
    { field: 'accountId', value: 'private-account\nheader' },
    { field: 'rootId', value: '' },
    { field: 'rootId', value: ' \t' },
    { field: 'rootId', value: 'private-root\u0000path' },
    { field: 'rootId', value: '\uD800' }
  ] as const)(
    'rejects invalid target $field=$value with a value-free error',
    ({ field, value }) => {
      expect(() => createStorageContextId('primary', { ...TARGET, [field]: value })).toThrow(
        configurationError
      );
    }
  );
});
