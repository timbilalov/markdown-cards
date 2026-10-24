import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
  describeConnections,
  resolveStorageConnections
} from '$lib/server/cloud/storageConnections';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  try {
    return json(describeConnections(await resolveStorageConnections(env)));
  } catch {
    return json({ error: 'CLOUD_NOT_CONFIGURED' }, { status: 503 });
  }
};
