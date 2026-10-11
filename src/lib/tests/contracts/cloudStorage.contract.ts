import { describe, expect, it } from 'vitest';
import type {
  CloudDocument,
  CloudStorageCapabilities,
  CloudStoragePort,
  CloudWriteResult
} from '../../ports/cloudStorage';

// A future HTTP-backed harness seeds its mock remote, not the adapter's logic.
// Tests interact only with the port. No parsing, revision generation or CAS here.
export interface CloudStorageContractHarness {
  name: string;
  capabilities: CloudStorageCapabilities;
  create(documents: readonly CloudDocument[]): CloudStoragePort;
}

const path = 'existing-note.md';
const source = '# Заметка 🗂\r\n\r\n<!-- future format: retain exactly -->\r\n';
const revision = 'Opaque:Rev/A==';
const existing: CloudDocument = { path, source, revision };
const other: CloudDocument = { path: 'another-note.md', source: '', revision: '10' };

function expectWritten(result: CloudWriteResult, hasRevisions: boolean): void {
  expect(result).toEqual({
    status: 'written', revision: hasRevisions ? expect.any(String) : null
  });
  if (result.status === 'written' && hasRevisions) expect(result.revision).not.toBe('');
}

export function defineCloudStorageContract(harness: CloudStorageContractHarness): void {
  const { capabilities, create } = harness;
  const expectedRevision = capabilities.revisions ? revision : null;

  describe(`${harness.name}: CloudStoragePort contract`, () => {
    it('reports its conditional-write and revision capabilities explicitly', () => {
      expect(create([]).getCapabilities()).toEqual(capabilities);
    });

    it('lists all stored paths and opaque revisions without exposing document content', async () => {
      const port = create([existing, other]);
      const result = await port.list();
      expect(result).toEqual({ status: 'success', entries: expect.arrayContaining([
        { path, revision: expectedRevision },
        { path: other.path, revision: capabilities.revisions ? other.revision : null }
      ]) });
      if (result.status !== 'success') return;
      expect(result.entries).toHaveLength(2);
      expect(await port.list()).toEqual(result);
    });

    it('returns a successful empty list for confirmed empty storage', async () => {
      expect(await create([]).list()).toEqual({ status: 'success', entries: [] });
    });

    it('reads the exact source by path with a stable revision, without parsing Markdown', async () => {
      const port = create([existing]);
      const expected = { status: 'found', document: { ...existing, revision: expectedRevision } };
      expect(await port.read(path)).toEqual(expected);
      expect(await port.read(path)).toEqual(expected);
    });

    it('retains an empty source as a found document', async () => {
      expect(await create([other]).read(other.path)).toEqual({
        status: 'found', document: { ...other, revision: capabilities.revisions ? other.revision : null }
      });
    });

    it('reports confirmed absence separately from a found empty document', async () => {
      expect(await create([other]).read(path)).toEqual({ status: 'not-found' });
    });

    it('uses the filename independently of an ID written inside the source', async () => {
      const document = { ...existing, source: '# Note\n\n## Meta\n\n### ID\n\ndifferent-id\n' };
      const port = create([document]);
      expect(await port.read(path)).toEqual({
        status: 'found', document: { ...document, revision: expectedRevision }
      });
      expect(await port.read('different-id.md')).toEqual({ status: 'not-found' });
    });

    if (capabilities.conditionalCreate) {
      it('creates only an absent path and returns the revision of the exact written source', async () => {
        const port = create([other]);
        const result = await port.write({ path, source, createOnly: true });
        expectWritten(result, capabilities.revisions);
        if (result.status !== 'written') return;
        expect(await port.read(path)).toEqual({ status: 'found', document: { path, source, revision: result.revision } });
        expect(await port.list()).toEqual({ status: 'success', entries: expect.arrayContaining([
          { path, revision: result.revision },
          { path: other.path, revision: capabilities.revisions ? other.revision : null }
        ]) });
        expect(await port.read(other.path)).toEqual({
          status: 'found', document: { ...other, revision: capabilities.revisions ? other.revision : null }
        });
      });

      it('refuses creation when the path already exists, even with the same source', async () => {
        const port = create([existing]);
        expect(await port.write({ path, source, createOnly: true }))
          .toEqual({ status: 'conflict' });
        expect(await port.read(path)).toEqual({
          status: 'found', document: { ...existing, revision: expectedRevision }
        });
      });

      it('allows exactly one of two concurrent creates at the same path', async () => {
        const port = create([]);
        const sources = ['first source', 'second source'];
        const results = await Promise.all(sources.map(source =>
          port.write({ path, source, createOnly: true })));
        expect(results).toEqual(expect.arrayContaining([
          { status: 'written', revision: capabilities.revisions ? expect.any(String) : null },
          { status: 'conflict' }
        ]));
        const winnerIndex = results.findIndex(result => result.status === 'written');
        const winner = results[winnerIndex];
        expectWritten(winner, capabilities.revisions);
        if (winner.status !== 'written') return;
        expect(await port.read(path)).toEqual({
          status: 'found', document: { path, source: sources[winnerIndex], revision: winner.revision }
        });
      });
    } else {
      it('refuses absent writes if conditional creation is unsupported', async () => {
        const port = create([]);
        expect(await port.write({ path, source, createOnly: true }))
          .toEqual({ status: 'unsupported', operation: 'create-only' });
        expect(await port.read(path)).toEqual({ status: 'not-found' });
      });
    }

  });
}
