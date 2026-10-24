import { getStorageSession } from './storageSession';
import type { StorageDescriptor } from '../server/cloud/storageRegistry';
import type { CloudFile, CloudFileListResponse } from '../types/cloud';
import { expireSession, sessionGeneration } from '../stores/sessionState';
import { cloudRequestSignal } from '../utils/cloudRequestSignal';
import { cloudErrorReason } from '../utils/cloudErrorReason';
import { checkIsMarkdownFilename } from '../domain/markdownFilename';

// Error types for better error handling
export class CloudError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'CloudError';
  }
}

export class CloudAuthError extends CloudError {
  constructor(message: string = 'Cloud authentication failed') {
    super(message, 'AUTH_FAILED');
    this.name = 'CloudAuthError';
  }
}

export class CloudNetworkError extends CloudError {
  constructor(message: string = 'Network error') {
    super(message, 'NETWORK_ERROR');
    this.name = 'CloudNetworkError';
  }
}

function checkIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkIsCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

// Validate the complete HTTP DTO before a caller can publish or cache any item.
// Return fresh objects so provider URLs and other extra fields stay outside it.
function parseCloudFileList(value: unknown): CloudFileListResponse | null {
  if (!checkIsRecord(value) || !checkIsRecord(value._embedded)
    || !Array.isArray(value._embedded.items)) return null;

  const names = new Set<string>();
  const items: CloudFile[] = [];
  for (const entry of value._embedded.items) {
    if (!checkIsRecord(entry) || !checkIsMarkdownFilename(entry.name)
      || entry.path !== entry.name || names.has(entry.name)) return null;
    if ('modified' in entry && !checkIsCanonicalTimestamp(entry.modified)) return null;
    if ('revision' in entry && (typeof entry.revision!=='string' || !entry.revision.trim() || /[\u0000-\u001f\u007f]/.test(entry.revision))) return null;
    names.add(entry.name);
    items.push({ name: entry.name, path: entry.name,
      ...(typeof entry.modified === 'string' ? { modified: entry.modified } : {}),
      ...(typeof entry.revision === 'string' ? { revision: entry.revision } : {}) });
  }
  return { _embedded: { items } };
}

// Browser read transport. Provider credentials and writes belong to server routes.
async function handleResponse(response: Response, generation: number): Promise<unknown> {
  if (!response.ok) {
    if (response.status === 401) expireSession(generation);
    // Provider auth failures use the server's 502 envelope, whereas the
    // browser session uses 401/403. Both require credentials, not backoff.
    const body: unknown = await response.json().catch(() => null);
    const reason = cloudErrorReason(response.status, checkIsRecord(body) ? body.error : undefined);
    if (reason === 'auth') {
      throw new CloudAuthError('Authentication failed');
    }

    if (reason === 'network') {
      throw new CloudNetworkError(`Server error: ${response.status}`);
    }

    if (reason === 'invalid-response')
      throw new CloudError('Invalid provider response', 'INVALID_RESPONSE');

    throw new CloudError(`HTTP error! status: ${response.status}`, `HTTP_${response.status}`);
  }
  return await response.json();
}

export const cloudService = {
  // Browser listing uses the server session and private storage configuration.
  async listFiles(
    signal?: AbortSignal,
    context: StorageDescriptor | undefined = getStorageSession()?.descriptor ?? undefined,
    baseUrl = '/api/cloud'
  ): Promise<CloudFileListResponse> {
    const generation = sessionGeneration();
    signal = cloudRequestSignal(signal);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/files`, {
        method: 'GET',
        signal,
        ...(context ? { headers: { 'X-Storage-Context': context.contextId } } : {})
      });
    } catch {
      throw new CloudNetworkError('Failed to fetch cloud file list');
    }

    let body: unknown;
    try {
      body = await handleResponse(response, generation);
    } catch (error) {
      if (error instanceof CloudAuthError) throw error;
      if (signal.aborted) throw new CloudNetworkError('Cloud listing cancelled');
      if (error instanceof CloudError) throw error;
      throw new CloudError('Invalid cloud file list response', 'INVALID_RESPONSE');
    }
    const data = parseCloudFileList(body);
    if (!data) throw new CloudError('Invalid cloud file list response', 'INVALID_RESPONSE');
    if (signal.aborted) throw new CloudNetworkError('Cloud listing cancelled');

    return data;
  }
};
