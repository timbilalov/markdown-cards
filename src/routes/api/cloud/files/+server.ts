import { json } from '@sveltejs/kit';
import type { CloudStoragePort, CloudUnavailableReason } from '$lib/ports/cloudStorage';
import type { CloudFileListResponse } from '$lib/types/cloud';
import { createServerCloudStorage } from '$lib/server/cloud/serverCloudStorage';
import type { RequestHandler } from './$types';

const headers = { 'Cache-Control': 'private, no-store' };
const unavailableResponses: Record<CloudUnavailableReason, { status: number; error: string }> = {
  auth: { status: 502, error: 'CLOUD_AUTH_FAILED' },
  network: { status: 503, error: 'CLOUD_UNAVAILABLE' },
  remote: { status: 502, error: 'CLOUD_REMOTE_ERROR' },
  'invalid-response': { status: 502, error: 'CLOUD_INVALID_RESPONSE' }
};

export const GET: RequestHandler = async () => {
  let storage: CloudStoragePort;
  try {
    storage = createServerCloudStorage();
  } catch {
    return json({ success: false, error: 'CLOUD_NOT_CONFIGURED' }, { status: 503, headers });
  }

  const result = await storage.list();
  if (result.status === 'unavailable') {
    const { status, error } = unavailableResponses[result.reason];
    return json({ success: false, error }, { status, headers });
  }

  // Keep the existing browser envelope, exposing only metadata from the port.
  const files: CloudFileListResponse = { _embedded: { items: result.entries.map(entry => ({
    name: entry.path,
    path: entry.path,
    ...(entry.modifiedAt === undefined ? {} : { modified: new Date(entry.modifiedAt).toISOString() })
  })) } };
  return json(files, { headers });
};
