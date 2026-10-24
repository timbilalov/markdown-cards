import type { CloudUnavailableReason } from '../../ports/cloudStorage';

export const unavailableResponses = {
  auth: { status: 502, error: 'CLOUD_AUTH_FAILED' },
  network: { status: 503, error: 'CLOUD_UNAVAILABLE' },
  remote: { status: 502, error: 'CLOUD_REMOTE_ERROR' },
  'invalid-response': { status: 502, error: 'CLOUD_INVALID_RESPONSE' }
} as const satisfies Record<CloudUnavailableReason, { status: number; error: string }>;
