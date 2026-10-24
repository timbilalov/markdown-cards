import { unavailableResponses } from '$lib/server/cloud/cloudErrorResponses';
import { json } from '@sveltejs/kit';
import type { CloudFileListResponse } from '$lib/types/cloud';
import type { RequestHandler } from './$types';

const headers = { 'Cache-Control': 'private, no-store' };

export const GET: RequestHandler = async ({ locals }) => {
  const storage = locals.cloudStorage;
  if (!storage) {
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
    ...(entry.revision === null ? {} : { revision: entry.revision }),
    ...(entry.modifiedAt === undefined ? {} : { modified: new Date(entry.modifiedAt).toISOString() })
  })) } };
  return json(files, { headers });
};
