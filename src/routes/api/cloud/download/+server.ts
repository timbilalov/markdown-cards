import { json } from '@sveltejs/kit';
import { checkIsMarkdownFilename } from '$lib/domain/markdownFilename';
import type { CloudStoragePort, CloudUnavailableReason } from '$lib/ports/cloudStorage';
import { createServerCloudStorage } from '$lib/server/cloud/serverCloudStorage';
import type { RequestHandler } from './$types';

const headers = { 'Cache-Control': 'private, no-store' };
const unavailableResponses: Record<CloudUnavailableReason, { status: number; error: string }> = {
  auth: { status: 502, error: 'CLOUD_AUTH_FAILED' },
  network: { status: 503, error: 'CLOUD_UNAVAILABLE' },
  remote: { status: 502, error: 'CLOUD_REMOTE_ERROR' },
  'invalid-response': { status: 502, error: 'CLOUD_INVALID_RESPONSE' }
};

function errorResponse(error: string, status: number): Response {
  return json({ success: false, error }, { status, headers });
}

export const GET: RequestHandler = async ({ url }) => {
  const paths = url.searchParams.getAll('path');
  if (url.searchParams.has('url') || paths.length !== 1 || !checkIsMarkdownFilename(paths[0])) {
    return errorResponse('CLOUD_INVALID_PATH', 400);
  }

  let storage: CloudStoragePort;
  try {
    storage = createServerCloudStorage();
  } catch {
    return errorResponse('CLOUD_NOT_CONFIGURED', 503);
  }

  // URLSearchParams already decoded the filename. The port validates the
  // segment and obtains a trusted download link inside the configured root.
  const result = await storage.read(paths[0]);
  switch (result.status) {
    case 'invalid':
      return errorResponse('CLOUD_INVALID_PATH', 400);
    case 'not-found':
      return errorResponse('CLOUD_NOT_FOUND', 404);
    case 'unavailable': {
      const { error, status } = unavailableResponses[result.reason];
      return errorResponse(error, status);
    }
    case 'found':
      return new Response(result.document.source, {
        headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }
      });
  }
};
