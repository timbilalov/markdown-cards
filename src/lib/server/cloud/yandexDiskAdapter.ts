import type {
  CloudListEntry, CloudListResult, CloudReadResult, CloudStorageCapabilities, CloudStoragePort,
  CloudUnavailable, CloudWriteRequest, CloudWriteResult
} from '../../ports/cloudStorage';
import { readResponseBytes, readResponseJson } from './providerResponse';
import { cloudRequestSignal, providerOperationTimeoutMs } from '../../utils/cloudRequestSignal';
import { checkIsMarkdownFilename } from '../../domain/markdownFilename';

const resourcesUrl = 'https://cloud-api.yandex.net/v1/disk/resources';
const configurationError = 'Invalid Yandex Disk configuration';
// Application budgets, not provider API limits. Listing budgets are per call.
const responseLimits = {
  link: 64 * 1024, page: 1024 * 1024, source: 1024 * 1024,
  listing: 8 * 1024 * 1024, pages: 100
};

export interface YandexDiskAdapterOptions {
  accessToken: string;
  // Relative folder under disk:/, supplied by server configuration, not the UI.
  rootPath: string;
  pageSize?: number;
}

interface DiskResource {
  name: string;
  type: 'file' | 'dir';
  path: string;
  modifiedAt?: number;
}

interface DiskPage {
  items: DiskResource[];
  limit: number;
  total: number | undefined;
}

function checkIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkIsPathSegment(value: unknown): value is string {
  return typeof value === 'string' && value.isWellFormed() && value.length > 0 && value !== '.' && value !== '..'
    && !/[\\/%:\u0000-\u001f\u007f]/.test(value);
}

function checkIsPageSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100;
}

function parseModificationTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || match[0] !== value) return null;

  // Date.parse can normalize impossible dates. Validate the calendar first.
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59) return null;

  const zone = match[7];
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseSecureUrl(value: unknown): URL | null {
  // Reject syntax that URL parsing could silently normalize before validation.
  if (typeof value !== 'string' || !value.isWellFormed() || !/^https:\/\//i.test(value)
    || /[\\\u0000-\u0020\u007f#]/.test(value) || /^https:\/\/[^/?#]*@/i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.port === '' && url.username === '' && url.password === ''
      ? url : null;
  } catch {
    return null;
  }
}

function checkIsDownloadUrl(value: unknown): value is string {
  const url = parseSecureUrl(value);
  return url !== null
    && (url.hostname === 'downloader.dst.yandex.ru' || url.hostname === 'downloader.disk.yandex.ru')
    && url.pathname.startsWith('/disk/') && url.pathname.length > '/disk/'.length;
}

function checkIsStorageUrl(value: unknown): value is string {
  const url = parseSecureUrl(value);
  return url !== null
    && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+storage\.yandex\.net$/.test(url.hostname);
}

function checkIsUploadUrl(value: unknown): value is string {
  const url = parseSecureUrl(value);
  return url !== null && /^uploader[a-z0-9]+\.(?:dst|disk)\.yandex\.net$/.test(url.hostname)
    && url.pathname.startsWith('/upload-target/') && url.pathname.length > '/upload-target/'.length;
}

function createHttpFailure(status: number): CloudUnavailable {
  return { status: 'unavailable', reason: status === 401 || status === 403 ? 'auth' : 'remote' };
}

function parsePage(value: unknown, rootPath: string, offset: number, pageSize: number): DiskPage | null {
  if (!checkIsRecord(value) || value.type !== 'dir' || value.path !== rootPath
    || !checkIsRecord(value._embedded)) return null;

  const { items, path, offset: returnedOffset, limit, total } = value._embedded;
  if (path !== rootPath || returnedOffset !== offset || !checkIsPageSize(limit)
    || limit > pageSize || !Array.isArray(items) || items.length > limit) return null;
  if (total !== undefined && (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0)) {
    return null;
  }

  const nextOffset = offset + items.length;
  if (!Number.isSafeInteger(nextOffset) || (total !== undefined
    && (nextOffset > total || (items.length === 0 && offset < total)))) return null;

  const resources: DiskResource[] = [];
  for (const item of items) {
    if (!checkIsRecord(item) || !checkIsPathSegment(item.name)
      || (item.type !== 'file' && item.type !== 'dir')
      || item.path !== `${rootPath}/${item.name}`) return null;
    const resource: DiskResource = { name: item.name, type: item.type, path: item.path };
    if (item.type === 'file' && checkIsMarkdownFilename(item.name) && 'modified' in item) {
      const modifiedAt = parseModificationTime(item.modified);
      if (modifiedAt === null) return null;
      resource.modifiedAt = modifiedAt;
    }
    resources.push(resource);
  }
  return { items: resources, limit, total };
}

// Server-only by directory. Creation can be protected against an existing path.
export class YandexDiskAdapter implements CloudStoragePort {
  private readonly accessToken: string;
  private readonly rootPath: string;
  private readonly pageSize: number;
  private readonly listUrl: string;

  constructor(options: YandexDiskAdapterOptions) {
    const pageSize = options.pageSize === undefined ? 100 : options.pageSize;
    if (typeof options.accessToken !== 'string' || options.accessToken.trim().length === 0
      || /[\r\n]/.test(options.accessToken) || typeof options.rootPath !== 'string'
      || !options.rootPath.split('/').every(checkIsPathSegment) || !checkIsPageSize(pageSize)) {
      throw new Error(configurationError);
    }
    this.accessToken = options.accessToken;
    this.rootPath = `disk:/${options.rootPath}`;
    this.pageSize = pageSize;
    try {
      this.listUrl = `${resourcesUrl}?path=${encodeURIComponent(this.rootPath)}&limit=${pageSize}`;
    } catch {
      // Invalid Unicode in configuration must not leak through a URIError.
      throw new Error(configurationError);
    }
  }

  getCapabilities(): CloudStorageCapabilities {
    return { revisions: false, conditionalCreate: true };
  }

  async write({ path, source, createOnly }: CloudWriteRequest): Promise<CloudWriteResult> {
    const signal = cloudRequestSignal(undefined, providerOperationTimeoutMs);
    if (createOnly !== undefined && typeof createOnly !== 'boolean') {
      return { status: 'invalid', reason: 'invalid-create-only' };
    }
    if (!checkIsPathSegment(path)) return { status: 'invalid', reason: 'invalid-path' };
    let encodedPath: string;
    try {
      encodedPath = encodeURIComponent(`${this.rootPath}/${path}`);
    } catch {
      return { status: 'invalid', reason: 'invalid-path' };
    }
    if (typeof source !== 'string' || !source.isWellFormed()) {
      return { status: 'invalid', reason: 'invalid-source' };
    }
    const bytes = new TextEncoder().encode(source);

    let response: Response;
    try {
      response = await fetch(`${resourcesUrl}/upload?path=${encodedPath}&overwrite=${createOnly !== true}`, {
        method: 'GET', redirect: 'error', signal,
        headers: { Accept: 'application/json', Authorization: `OAuth ${this.accessToken}` }
      });
    } catch {
      return { status: 'unavailable', reason: 'network', outcome: 'not-written' };
    }
    if (response.status === 409) return { status: 'conflict' };
    if (response.status !== 200) return { ...createHttpFailure(response.status), outcome: 'not-written' };

    const linkResponse = await readResponseJson(response, responseLimits.link);
    if (signal.aborted) return { status: 'unavailable', reason: 'network', outcome: 'not-written' };
    if (linkResponse.status !== 'success') {
      return { status: 'unavailable', reason: 'invalid-response', outcome: 'not-written' };
    }
    const link = linkResponse.value;
    if (!checkIsRecord(link) || link.method !== 'PUT' || link.templated !== false
      || !checkIsUploadUrl(link.href)) {
      return { status: 'unavailable', reason: 'invalid-response', outcome: 'not-written' };
    }

    try {
      // The signed upload URL receives exact bytes, without OAuth or redirects.
      response = await fetch(link.href, {
        method: 'PUT', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/octet-stream' }, body: bytes
      });
    } catch {
      return { status: 'unavailable', reason: 'network', outcome: 'unknown' };
    }
    if (response.status === 201) return { status: 'written', revision: null };
    if (response.status === 409) return { status: 'conflict' };
    // Once PUT has started, neither a lost response nor 202 proves completion
    // or absence of a write. Keep that uncertainty visible to the caller.
    return { ...createHttpFailure(response.status), outcome: 'unknown' };
  }

  async read(path: string): Promise<CloudReadResult> {
    const signal = cloudRequestSignal(undefined, providerOperationTimeoutMs);
    if (!checkIsPathSegment(path)) return { status: 'invalid', reason: 'invalid-path' };
    let encodedPath: string;
    try {
      encodedPath = encodeURIComponent(`${this.rootPath}/${path}`);
    } catch {
      return { status: 'invalid', reason: 'invalid-path' };
    }

    let response: Response;
    try {
      response = await fetch(`${resourcesUrl}/download?path=${encodedPath}`, {
        method: 'GET', redirect: 'error', signal,
        headers: { Accept: 'application/json', Authorization: `OAuth ${this.accessToken}` }
      });
    } catch {
      return { status: 'unavailable', reason: 'network' };
    }
    // Only this API response establishes absence. A download URL may have expired.
    if (response.status === 404) return { status: 'not-found' };
    if (response.status !== 200) return createHttpFailure(response.status);

    const linkResponse = await readResponseJson(response, responseLimits.link);
    if (signal.aborted) return { status: 'unavailable', reason: 'network' };
    if (linkResponse.status !== 'success') {
      return { status: 'unavailable', reason: 'invalid-response' };
    }
    const link = linkResponse.value;
    if (!checkIsRecord(link) || link.method !== 'GET' || link.templated !== false
      || !checkIsDownloadUrl(link.href)) return { status: 'unavailable', reason: 'invalid-response' };

    return this.downloadSource(path, link.href, signal);
  }

  private async downloadSource(path: string, href: string, signal: AbortSignal): Promise<CloudReadResult> {
    let hasRedirected = false;
    while (true) {
      const headers: Record<string, string> = { Accept: 'application/octet-stream' };
      if (!hasRedirected) headers.Authorization = `OAuth ${this.accessToken}`;
      let response: Response;
      try {
        // Keep the signed URL intact; each destination is checked before fetching.
        response = await fetch(href, { method: 'GET', redirect: 'manual', headers, signal });
      } catch {
        return { status: 'unavailable', reason: 'network' };
      }
      if (response.status === 302) {
        const location = response.headers.get('Location');
        if (hasRedirected || !checkIsStorageUrl(location)) {
          return { status: 'unavailable', reason: 'invalid-response' };
        }
        href = location;
        hasRedirected = true;
        continue;
      }
      if (response.status !== 200) return createHttpFailure(response.status);

      const body = await readResponseBytes(response, responseLimits.source);
      if (body.status !== 'success') {
        return { status: 'unavailable', reason: body.status === 'unreadable' ? 'network' : 'invalid-response' };
      }
      let source: string;
      try {
        // Preserve BOM as part of the source and never replace invalid UTF-8.
        source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body.bytes);
      } catch {
        return { status: 'unavailable', reason: 'invalid-response' };
      }
      return { status: 'found', document: { path, source, revision: null } };
    }
  }

  async list(): Promise<CloudListResult> {
    const signal = cloudRequestSignal(undefined, providerOperationTimeoutMs);
    const entries: CloudListEntry[] = [];
    const seenPaths = new Set<string>();
    let offset = 0;
    let total: number | undefined;
    let remainingBytes = responseLimits.listing;
    let pageCount = 0;

    while (true) {
      if (remainingBytes === 0 || pageCount === responseLimits.pages) {
        return { status: 'unavailable', reason: 'invalid-response' };
      }
      let response: Response;
      try {
        response = await fetch(`${this.listUrl}&offset=${offset}&sort=name`, {
          method: 'GET', signal,
          redirect: 'error',
          headers: { Accept: 'application/json', Authorization: `OAuth ${this.accessToken}` }
        });
      } catch {
        return { status: 'unavailable', reason: 'network' };
      }
      if (response.status !== 200) {
        return { status: 'unavailable', reason: response.status === 401 || response.status === 403
          ? 'auth' : 'remote' };
      }

      const body = await readResponseJson(response, Math.min(responseLimits.page, remainingBytes));
      if (signal.aborted) return { status: 'unavailable', reason: 'network' };
      if (body.status !== 'success') {
        return { status: 'unavailable', reason: 'invalid-response' };
      }
      remainingBytes -= body.byteLength;
      pageCount++;
      const page = parsePage(body.value, this.rootPath, offset, this.pageSize);
      if (page === null || (offset > 0 && page.total !== total)) {
        return { status: 'unavailable', reason: 'invalid-response' };
      }

      for (const item of page.items) {
        if (seenPaths.has(item.path)) return { status: 'unavailable', reason: 'invalid-response' };
        seenPaths.add(item.path);
        if (item.type === 'file' && checkIsMarkdownFilename(item.name)) {
          entries.push({ path: item.name, revision: null,
            ...(item.modifiedAt === undefined ? {} : { modifiedAt: item.modifiedAt }) });
        }
      }
      // Offsets count all resources, not only Markdown files. A known total
      // takes precedence over a short page; no partial result escapes on failure.
      offset += page.items.length;
      total = page.total;
      if (total !== undefined ? offset === total : page.items.length < page.limit) {
        return { status: 'success', entries };
      }
    }
  }
}
