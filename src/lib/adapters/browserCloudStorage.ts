import type { StorageDescriptor } from '../server/cloud/storageRegistry';
import type {
  CloudStoragePort, CloudStorageCapabilities, CloudReadResult, CloudWriteRequest, CloudWriteResult, CloudListResult
} from '../ports/cloudStorage';
import { CloudAuthError, CloudError, CloudNetworkError, cloudService } from '../services/cloudService';
import { expireSession, sessionGeneration } from '../stores/sessionState';
import { cloudRequestSignal } from '../utils/cloudRequestSignal';
import { cloudErrorReason } from '../utils/cloudErrorReason';
import { checkIsMarkdownFilename } from '../domain/markdownFilename';

async function readError(response: Response): Promise<{ error?: string; outcome?: string }> {
  try { return await response.json(); } catch { return {}; }
}
// Same-origin session transport. Writes have no automatic HTTP retries: the
// application persists and interprets their outcome before deciding anything.
export class BrowserCloudStorage implements CloudStoragePort {
  private readonly descriptor?: StorageDescriptor;
  constructor(descriptor?: StorageDescriptor, private readonly baseUrl = '/api/cloud') { this.descriptor = descriptor ? structuredClone(descriptor) : undefined; }
  getCapabilities(): CloudStorageCapabilities { return this.descriptor ? { ...this.descriptor.capabilities } : { revisions: false, conditionalCreate: true }; }

  async list(signal?: AbortSignal): Promise<CloudListResult> {
    try {
      const result = await cloudService.listFiles(signal, this.descriptor, this.baseUrl);
      return { status: 'success', entries: result._embedded.items.map(file => ({ path: file.name, revision: file.revision ?? null,
        ...(file.modified === undefined ? {} : { modifiedAt: Date.parse(file.modified) }) })) };
    } catch (error) {
      return { status: 'unavailable', reason: error instanceof CloudAuthError ? 'auth'
        : error instanceof CloudNetworkError ? 'network' : error instanceof CloudError && error.code === 'INVALID_RESPONSE'
          ? 'invalid-response' : 'remote' };
    }
  }

  async read(path: string, signal?: AbortSignal): Promise<CloudReadResult> {
    if (!checkIsMarkdownFilename(path)) return { status: 'invalid', reason: 'invalid-path' };
    const listed = await this.list(signal);
    if (signal?.aborted) return { status: 'unavailable', reason: 'network' };
    if (listed.status !== 'success') return listed;
    if (!listed.entries.some(entry => entry.path === path)) return { status: 'not-found' };
    return this.readListed(path, signal);
  }

  async readListed(path: string, signal?: AbortSignal): Promise<CloudReadResult> {
    if (!checkIsMarkdownFilename(path)) return { status: 'invalid', reason: 'invalid-path' };
    const generation = sessionGeneration();
    signal = cloudRequestSignal(signal);
    try {
      if (signal.aborted) return { status: 'unavailable', reason: 'network' };
      const response = await fetch(`${this.baseUrl}/download?path=${encodeURIComponent(path)}`, { method: 'GET', signal,
        ...(this.descriptor ? { headers: { 'X-Storage-Context': this.descriptor.contextId } } : {}) });
      if (!response.ok) {
        if (response.status === 401) expireSession(generation);
        if (response.status === 401 || response.status === 403) return { status: 'unavailable', reason: 'auth' };
        if (response.status === 404) return { status: 'not-found' };
        const body = await readError(response);
        if (signal.aborted) return { status: 'unavailable', reason: 'network' };
        return { status: 'unavailable', reason: cloudErrorReason(response.status, body?.error) };
      }
      try {
        const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await response.arrayBuffer());
        return { status: 'found', document: { path, source, revision: response.headers.get('X-Cloud-Revision') } };
      } catch { return { status: 'unavailable', reason: signal.aborted ? 'network' : 'invalid-response' }; }
    } catch { return { status: 'unavailable', reason: 'network' }; }
  }

  async write(input: CloudWriteRequest): Promise<CloudWriteResult> {
    if (input.expectedRevision !== undefined) {
      if (!this.getCapabilities().conditionalUpdate) return { status: 'unsupported', operation: 'conditional-update' };
      if (typeof input.expectedRevision !== 'string' || !input.expectedRevision.trim() || input.createOnly) return { status: 'invalid', reason: 'invalid-revision' };
    }
    if (!checkIsMarkdownFilename(input.path)) return { status: 'invalid', reason: 'invalid-path' };
    const generation = sessionGeneration();
    const body = new FormData();
    body.append('path', input.path);
    // String form fields normalize LF to CRLF in browsers. A file part keeps
    // the exact snapshot bytes used for acknowledgement and the next preflight.
    body.append('content', new Blob([input.source], { type: 'text/markdown' }), 'document.md');
    body.append('overwrite', String(!input.createOnly));
    try {
      const signal = cloudRequestSignal();
      const response = await fetch(`${this.baseUrl}/upload`, { method: 'POST', body, signal,
        ...(this.descriptor ? { headers: { 'X-Storage-Context': this.descriptor.contextId,
          ...(input.expectedRevision === undefined ? {} : { 'X-Expected-Revision': input.expectedRevision }) } } : {}) });
      if (response.status === 401) expireSession(generation);
      if (response.status === 200 && !response.redirected) {
        const revision = response.headers.get('X-Cloud-Revision');
        return this.getCapabilities().revisions && !revision ? { status: 'unavailable', reason: 'invalid-response', outcome: 'unknown' }
          : { status: 'written', revision };
      }
      // These statuses establish rejection before a write without needing to
      // wait for an error body that might itself stall.
      if (response.status === 401 || response.status === 403) return { status: 'unavailable', reason: 'auth', outcome: 'not-written' };
      if (response.status === 409) {
        const error = await readError(response);
        return error.error === 'CLOUD_CONTEXT_MISMATCH' ? { status: 'unavailable', reason: 'remote', outcome: 'not-written' } : { status: 'conflict' };
      }
      if ([400, 413, 415, 422].includes(response.status)) return { status: 'invalid', reason: 'invalid-source' };
      const error = await readError(response);
      if (signal.aborted) return { status: 'unavailable', reason: 'network', outcome: 'unknown' };
      if (error?.error === 'CLOUD_WRITE_UNSUPPORTED') return { status: 'unsupported', operation: 'create-only' };
      return { status: 'unavailable', reason: cloudErrorReason(response.status, error?.error),
        outcome: error?.outcome === 'not-written' ? 'not-written' : 'unknown' };
    } catch { return { status: 'unavailable', reason: 'network', outcome: 'unknown' }; }
  }
}
