import type {
  CloudStoragePort,
  CloudListResult,
  CloudReadResult,
  CloudWriteRequest,
  CloudWriteResult,
  CloudUnavailable
} from '../../ports/cloudStorage';
import type { StorageIdentityResult } from './storageRegistry';
import { readResponseBytes, readResponseJson } from './providerResponse';
import { cloudRequestSignal, providerOperationTimeoutMs } from '../../utils/cloudRequestSignal';
import { checkIsMarkdownFilename } from '../../domain/markdownFilename';
import { checkIsIdentityText as text } from '../../utils/storageValidation';

export interface DropboxAdapterOptions {
  appKey: string;
  appSecret: string;
  refreshToken: string;
  rootPath: string;
}

export type { StorageIdentityResult } from './storageRegistry';
const api = 'https://api.dropboxapi.com';
const contentApi = 'https://content.dropboxapi.com';
const sourceLimit = 1024 * 1024;
const invalid: CloudUnavailable = { status: 'unavailable', reason: 'invalid-response' };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failure(status: number): CloudUnavailable {
  return { status: 'unavailable', reason: status === 401 || status === 403 ? 'auth' : 'remote' };
}

function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[^\x00-\x7f]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

// Each call has one deadline covering refresh, pagination and response bodies.
// Uploads are never retried, including after a lost acknowledgement.
export class DropboxAdapter implements CloudStoragePort {
  private readonly options: DropboxAdapterOptions;
  private token?: { value: string; expires: number };
  constructor(options: DropboxAdapterOptions) {
    const root = options.rootPath;
    if (
      ![options.appKey, options.appSecret, options.refreshToken].every(text) ||
      typeof root !== 'string' ||
      (root !== '' &&
        (!root.startsWith('/') ||
          !root
            .slice(1)
            .split('/')
            .every(
              segment =>
                text(segment) && !/[\\:]/.test(segment) && segment !== '.' && segment !== '..'
            )))
    ) {
      throw new Error('Invalid Dropbox configuration');
    }
    this.options = { ...options };
  }
  getCapabilities() {
    return {
      revisions: true,
      conditionalCreate: true,
      conditionalUpdate: true,
      caseSensitivePaths: false
    };
  }

  private async access(signal: AbortSignal): Promise<string | CloudUnavailable> {
    if (this.token && this.token.expires > Date.now()) return this.token.value;
    try {
      const response = await fetch(`${api}/oauth2/token`, {
        method: 'POST',
        redirect: 'error',
        signal,
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.options.refreshToken,
          client_id: this.options.appKey,
          client_secret: this.options.appSecret
        })
      });
      if (!response.ok)
        return response.status === 400
          ? { status: 'unavailable', reason: 'auth' }
          : failure(response.status);
      const body = await readResponseJson(response, 64 * 1024);
      if (
        body.status !== 'success' ||
        !record(body.value) ||
        !text(body.value.access_token) ||
        typeof body.value.expires_in !== 'number' ||
        !Number.isFinite(body.value.expires_in) ||
        body.value.expires_in <= 0
      )
        return invalid;
      this.token = {
        value: body.value.access_token,
        expires: Date.now() + Math.max(0, body.value.expires_in - 30) * 1000
      };
      return this.token.value;
    } catch {
      return { status: 'unavailable', reason: 'network' };
    }
  }
  private async request(
    route: string,
    body: unknown,
    signal: AbortSignal
  ): Promise<Response | CloudUnavailable> {
    const token = await this.access(signal);
    if (typeof token !== 'string') return token;
    try {
      return await fetch(`${api}/2/${route}`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch {
      return { status: 'unavailable', reason: 'network' };
    }
  }
  private metadata(
    value: unknown,
    path?: string
  ): { name: string; revision: string; modifiedAt: number } | null {
    if (
      !record(value) ||
      (value['.tag'] !== undefined && value['.tag'] !== 'file') ||
      !checkIsMarkdownFilename(value.name) ||
      !text(value.rev) ||
      value.path_lower !== `${this.options.rootPath}/${value.name}`.toLowerCase() ||
      (path !== undefined && value.name.toLowerCase() !== path.toLowerCase()) ||
      typeof value.server_modified !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value.server_modified)
    )
      return null;
    const modifiedAt = Date.parse(value.server_modified);
    if (!Number.isFinite(modifiedAt)) return null;
    return { name: value.name, revision: value.rev, modifiedAt };
  }
  async list(): Promise<CloudListResult> {
    const signal = cloudRequestSignal(undefined, providerOperationTimeoutMs);
    const entries: Extract<CloudListResult, { status: 'success' }>['entries'] = [];
    const paths = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let budget = 8 * sourceLimit;
    for (let page = 0; page < 100 && budget > 0; page++) {
      const response = await this.request(
        cursor === undefined ? 'files/list_folder' : 'files/list_folder/continue',
        cursor === undefined
          ? { path: this.options.rootPath, recursive: false, include_deleted: false }
          : { cursor },
        signal
      );
      if (!(response instanceof Response)) return response;
      if (response.status !== 200) return failure(response.status);
      const body = await readResponseJson(response, Math.min(sourceLimit, budget));
      if (signal.aborted) return { status: 'unavailable', reason: 'network' };
      if (
        body.status !== 'success' ||
        !record(body.value) ||
        !Array.isArray(body.value.entries) ||
        typeof body.value.has_more !== 'boolean' ||
        !text(body.value.cursor)
      )
        return invalid;
      budget -= body.byteLength;
      for (const item of body.value.entries) {
        if (!record(item) || !text(item.name) || !['folder', 'file'].includes(String(item['.tag'])))
          return invalid;
        if (item['.tag'] !== 'file' || !checkIsMarkdownFilename(item.name)) continue;
        const metadata = this.metadata(item);
        if (!metadata || paths.has(metadata.name.toLowerCase())) return invalid;
        paths.add(metadata.name.toLowerCase());
        entries.push({
          path: metadata.name,
          revision: metadata.revision,
          modifiedAt: metadata.modifiedAt
        });
      }
      if (!body.value.has_more) return { status: 'success', entries };
      cursor = body.value.cursor;
      if (cursors.has(cursor)) return invalid;
      cursors.add(cursor);
    }
    return invalid;
  }
  async read(path: string, callerSignal?: AbortSignal): Promise<CloudReadResult> {
    if (!checkIsMarkdownFilename(path)) return { status: 'invalid', reason: 'invalid-path' };
    const signal = cloudRequestSignal(callerSignal, providerOperationTimeoutMs);
    const token = await this.access(signal);
    if (typeof token !== 'string') return token;
    let response: Response;
    try {
      response = await fetch(`${contentApi}/2/files/download`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Dropbox-API-Arg': asciiJson({ path: `${this.options.rootPath}/${path}` })
        }
      });
    } catch {
      return { status: 'unavailable', reason: 'network' };
    }
    try {
      if (response.status === 409) {
        const body = await readResponseJson(response, 64 * 1024);
        const error = body.status === 'success' && record(body.value) ? body.value.error : null;
        if (
          record(error) &&
          error['.tag'] === 'path' &&
          record(error.path) &&
          error.path['.tag'] === 'not_found'
        )
          return { status: 'not-found' };
      }
      if (response.status !== 200) return failure(response.status);
      const metadata = this.metadata(
        JSON.parse(response.headers.get('Dropbox-API-Result') ?? 'null'),
        path
      );
      if (!metadata) return invalid;
      const body = await readResponseBytes(response, sourceLimit);
      if (signal.aborted) return { status: 'unavailable', reason: 'network' };
      if (body.status !== 'success') return invalid;
      try {
        const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          body.bytes
        );
        return { status: 'found', document: { path, source, revision: metadata.revision } };
      } catch {
        return invalid;
      }
    } catch {
      return { status: 'unavailable', reason: signal.aborted ? 'network' : 'invalid-response' };
    }
  }
  async write(input: CloudWriteRequest): Promise<CloudWriteResult> {
    if (!checkIsMarkdownFilename(input.path)) return { status: 'invalid', reason: 'invalid-path' };
    if (input.createOnly !== undefined && typeof input.createOnly !== 'boolean')
      return { status: 'invalid', reason: 'invalid-create-only' };
    if (input.expectedRevision !== undefined && (!text(input.expectedRevision) || input.createOnly))
      return { status: 'invalid', reason: 'invalid-revision' };
    if (
      typeof input.source !== 'string' ||
      !input.source.isWellFormed() ||
      new TextEncoder().encode(input.source).byteLength > sourceLimit
    )
      return { status: 'invalid', reason: 'invalid-source' };
    const signal = cloudRequestSignal(undefined, providerOperationTimeoutMs);
    const token = await this.access(signal);
    if (typeof token !== 'string') return { ...token, outcome: 'not-written' };
    try {
      const response = await fetch(`${contentApi}/2/files/upload`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': asciiJson({
            path: `${this.options.rootPath}/${input.path}`,
            mode:
              input.expectedRevision !== undefined
                ? { '.tag': 'update', update: input.expectedRevision }
                : input.createOnly
                  ? 'add'
                  : 'overwrite',
            autorename: false,
            strict_conflict: true,
            mute: true
          })
        },
        body: new TextEncoder().encode(input.source)
      });
      const body = await readResponseJson(response, 64 * 1024);
      if (response.status === 200) {
        const metadata = body.status === 'success' ? this.metadata(body.value, input.path) : null;
        return metadata
          ? { status: 'written', revision: metadata.revision }
          : { ...invalid, outcome: 'unknown' };
      }
      if (response.status === 409 && body.status === 'success' && record(body.value)) {
        const error = body.value.error;
        if (
          record(error) &&
          error['.tag'] === 'path' &&
          record(error.path) &&
          record(error.path.reason) &&
          error.path.reason['.tag'] === 'conflict'
        )
          return { status: 'conflict' };
      }
      return {
        ...failure(response.status),
        outcome: [400, 401, 403, 409, 429].includes(response.status) ? 'not-written' : 'unknown'
      };
    } catch {
      return { status: 'unavailable', reason: 'network', outcome: 'unknown' };
    }
  }
  async identify(): Promise<StorageIdentityResult> {
    const signal = cloudRequestSignal(undefined, providerOperationTimeoutMs);
    const accountResponse = await this.request('users/get_current_account', null, signal);
    if (!(accountResponse instanceof Response)) return accountResponse;
    if (accountResponse.status !== 200) return failure(accountResponse.status);
    const account = await readResponseJson(accountResponse, 64 * 1024);
    if (
      account.status !== 'success' ||
      !record(account.value) ||
      !text(account.value.account_id) ||
      !record(account.value.root_info) ||
      !text(account.value.root_info.home_namespace_id)
    )
      return invalid;
    let folderId = 'root';
    let canonicalPath = '';
    if (this.options.rootPath !== '') {
      const response = await this.request(
        'files/get_metadata',
        { path: this.options.rootPath },
        signal
      );
      if (!(response instanceof Response)) return response;
      if (response.status !== 200) return failure(response.status);
      const folder = await readResponseJson(response, 64 * 1024);
      if (
        folder.status !== 'success' ||
        !record(folder.value) ||
        folder.value['.tag'] !== 'folder' ||
        !text(folder.value.id) ||
        folder.value.path_lower !== this.options.rootPath.toLowerCase()
      )
        return invalid;
      folderId = folder.value.id;
      canonicalPath = folder.value.path_lower;
    }
    return {
      status: 'success',
      identity: {
        provider: 'dropbox',
        accountId: account.value.account_id,
        rootId: JSON.stringify([
          this.options.appKey,
          account.value.root_info.home_namespace_id,
          folderId,
          canonicalPath
        ])
      }
    };
  }
}
