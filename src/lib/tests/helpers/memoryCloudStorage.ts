import type {
  CloudDocument,
  CloudListResult,
  CloudReadResult,
  CloudStorageCapabilities,
  CloudStoragePort,
  CloudWriteRequest,
  CloudWriteResult
} from '../../ports/cloudStorage';

export interface MemoryCloudStorageOptions {
  documents?: readonly CloudDocument[];
  capabilities?: CloudStorageCapabilities;
}

// Reference adapter for the shared contract suite, not a production provider.
export class MemoryCloudStorage implements CloudStoragePort {
  private readonly documents = new Map<string, CloudDocument>();
  private readonly capabilities: CloudStorageCapabilities;
  private readonly usedRevisions = new Set<string>();
  private revisionSequence = 0;

  constructor(options: MemoryCloudStorageOptions = {}) {
    this.capabilities = {
      ...(options.capabilities ?? {
        revisions: true,
        conditionalCreate: true
      })
    };
    for (const document of options.documents ?? []) {
      const revision = this.capabilities.revisions ? document.revision : null;
      this.documents.set(document.path, { ...document, revision });
      if (revision !== null) this.usedRevisions.add(revision);
    }
  }

  getCapabilities(): CloudStorageCapabilities {
    return { ...this.capabilities };
  }

  async list(): Promise<CloudListResult> {
    return {
      status: 'success',
      entries: Array.from(this.documents.values(), ({ path, revision }) => ({ path, revision }))
    };
  }

  async read(path: string): Promise<CloudReadResult> {
    const document = this.documents.get(path);
    return document ? { status: 'found', document: { ...document } } : { status: 'not-found' };
  }

  async write({
    path,
    source,
    createOnly,
    expectedRevision
  }: CloudWriteRequest): Promise<CloudWriteResult> {
    if (createOnly !== undefined && typeof createOnly !== 'boolean') {
      return { status: 'invalid', reason: 'invalid-create-only' };
    }
    if (expectedRevision !== undefined) {
      if (!this.capabilities.conditionalUpdate)
        return { status: 'unsupported', operation: 'conditional-update' };
      if (createOnly || typeof expectedRevision !== 'string' || !expectedRevision)
        return { status: 'invalid', reason: 'invalid-revision' };
      if (this.documents.get(path)?.revision !== expectedRevision) return { status: 'conflict' };
    }
    // No await between checking absence and storing on this instance.
    if (createOnly === true) {
      if (!this.capabilities.conditionalCreate)
        return { status: 'unsupported', operation: 'create-only' };
      if (this.documents.has(path)) return { status: 'conflict' };
    }

    const revision = this.capabilities.revisions ? this.createRevision() : null;
    this.documents.set(path, { path, source, revision });
    return { status: 'written', revision };
  }

  private createRevision(): string {
    // Seed tokens are opaque too; generated tokens must not collide with them.
    let revision: string;
    do {
      revision = `memory:${++this.revisionSequence}`;
    } while (this.usedRevisions.has(revision));
    this.usedRevisions.add(revision);
    return revision;
  }
}
