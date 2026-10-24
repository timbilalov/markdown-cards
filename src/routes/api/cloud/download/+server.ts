import { unavailableResponses } from '$lib/server/cloud/cloudErrorResponses';
import { json } from '@sveltejs/kit';
import { checkIsMarkdownFilename } from '$lib/domain/markdownFilename';
import type { RequestHandler } from './$types';

const headers = { 'Cache-Control': 'private, no-store' };

function errorResponse(error: string, status: number): Response {
  return json({ success: false, error }, { status, headers });
}

export const GET: RequestHandler = async ({ url, locals }) => {
  const paths = url.searchParams.getAll('path');
  if (url.searchParams.has('url') || paths.length !== 1 || !checkIsMarkdownFilename(paths[0])) {
    return errorResponse('CLOUD_INVALID_PATH', 400);
  }

  const storage = locals.cloudStorage;
  if (!storage) {
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
        headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8',
          ...(result.document.revision === null ? {} : { 'X-Cloud-Revision': result.document.revision }) }
      });
  }
};
