import { json } from '@sveltejs/kit';
import { parseMarkdownDocument } from '$lib/domain/markdown';
import { checkIsMarkdownFilename } from '$lib/domain/markdownFilename';
import type { CloudStoragePort, CloudUnavailableReason, CloudWriteResult } from '$lib/ports/cloudStorage';
import { createServerCloudStorage } from '$lib/server/cloud/serverCloudStorage';
import { readRequestBody } from '$lib/server/requestBody';
import type { RequestHandler } from './$types';

const headers = { 'Cache-Control': 'private, no-store' };
const bodyErrors = {
  'unsupported-media-type': { status: 415, error: 'UNSUPPORTED_MEDIA_TYPE' },
  'too-large': { status: 413, error: 'REQUEST_BODY_TOO_LARGE' },
  invalid: { status: 400, error: 'INVALID_REQUEST_BODY' }
};
const allowedFields = new Set(['path', 'content', 'overwrite']);
const unavailableResponses: Record<CloudUnavailableReason, { status: number; error: string }> = {
  auth: { status: 502, error: 'CLOUD_AUTH_FAILED' },
  network: { status: 503, error: 'CLOUD_UNAVAILABLE' },
  remote: { status: 502, error: 'CLOUD_REMOTE_ERROR' },
  'invalid-response': { status: 502, error: 'CLOUD_INVALID_RESPONSE' }
};

function checkHasValidUploadFields(formData: FormData): boolean {
  const seen = new Set<string>();
  for (const name of formData.keys()) {
    if (!allowedFields.has(name) || seen.has(name)) return false;
    seen.add(name);
  }
  const overwrite = formData.get('overwrite');
  return seen.has('path') && seen.has('content')
    && (overwrite === null || overwrite === 'true' || overwrite === 'false');
}

function createInvalidInputResponse(error: string): Response {
  return createErrorResponse(error, 400);
}

function createErrorResponse(error: string, status: number, outcome?: 'not-written' | 'unknown'): Response {
  return json({ success: false, error, ...(outcome ? { outcome } : {}) }, { status, headers });
}

export const POST: RequestHandler = async ({ request }) => {
  const bodyResult = await readRequestBody(request, 'multipart');
  if (bodyResult.status !== 'success') {
    const { status, error } = bodyErrors[bodyResult.status];
    return createErrorResponse(error, status);
  }
  let formData: FormData;
  try {
    formData = await bodyResult.response.formData();
  } catch {
    return createInvalidInputResponse('INVALID_REQUEST_BODY');
  }
  // Establish cardinality before selecting values or inspecting their content.
  if (!checkHasValidUploadFields(formData)) {
    return createInvalidInputResponse('INVALID_UPLOAD_FIELDS');
  }

  const filePath = formData.get('path');
  const content = formData.get('content');
  const overwrite = formData.get('overwrite') === 'true';

  if (!checkIsMarkdownFilename(filePath)) {
    return createInvalidInputResponse('CLOUD_INVALID_PATH');
  }

  // Accept the browser's byte-preserving Markdown part as well as older text
  // clients. Its filename is ignored; only the validated path authorizes a write.
  // readRequestBody already bounded and validated UTF-8 for the entire body.
  const fileContent = typeof content === 'string' ? content
    : content?.type === 'text/markdown'
      ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await content.arrayBuffer()) : null;
  if (fileContent === null || fileContent.length === 0) {
    return createInvalidInputResponse('INVALID_MARKDOWN_CONTENT');
  }

  const parsed = parseMarkdownDocument(fileContent);
  if (parsed.status !== 'success') {
    const isUnsupported = parsed.status === 'unsupported';
    return json({
      success: false,
      error: isUnsupported ? 'MARKDOWN_UNSUPPORTED' : 'MARKDOWN_INVALID',
      reason: parsed.reason
    }, { status: isUnsupported ? 422 : 400, headers });
  }

  let storage: CloudStoragePort;
  try {
    storage = createServerCloudStorage();
  } catch {
    return createErrorResponse('CLOUD_NOT_CONFIGURED', 503, 'not-written');
  }

  let result: CloudWriteResult;
  try {
    // Preserve the received source and destination; only translate the HTTP flag.
    result = await storage.write({ path: filePath, source: fileContent, createOnly: !overwrite });
  } catch {
    // An unexpected failure after starting the write cannot prove it was not applied.
    return createErrorResponse('CLOUD_WRITE_UNKNOWN', 503, 'unknown');
  }
  switch (result.status) {
    case 'written':
      return new Response('File uploaded successfully', { status: 200, headers });
    case 'conflict':
      return createErrorResponse('CLOUD_CONFLICT', 409);
    case 'unsupported':
      return createErrorResponse('CLOUD_WRITE_UNSUPPORTED', 503, 'not-written');
    case 'invalid':
      return createInvalidInputResponse(result.reason === 'invalid-path' ? 'CLOUD_INVALID_PATH'
        : result.reason === 'invalid-source' ? 'CLOUD_INVALID_SOURCE' : 'CLOUD_INVALID_WRITE_REQUEST');
    case 'unavailable': {
      if (result.outcome === 'unknown') {
        return createErrorResponse('CLOUD_WRITE_UNKNOWN', 503, 'unknown');
      }
      const { status, error } = unavailableResponses[result.reason];
      return createErrorResponse(error, status, 'not-written');
    }
  }
};
