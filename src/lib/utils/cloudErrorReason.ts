import type { CloudUnavailableReason } from '../ports/cloudStorage';

// The server's error code identifies the provider failure; an arbitrary 5xx
// alone does not establish a network error. Used by all browser cloud requests.
export function cloudErrorReason(status: number, code?: unknown): CloudUnavailableReason {
  if (status === 401 || status === 403 || code === 'CLOUD_AUTH_FAILED') return 'auth';
  if (code === 'CLOUD_INVALID_RESPONSE') return 'invalid-response';
  if (code === 'CLOUD_UNAVAILABLE' || code === 'CLOUD_NETWORK_ERROR') return 'network';
  return 'remote';
}
