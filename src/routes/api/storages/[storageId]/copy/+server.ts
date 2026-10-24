import { createHash } from 'node:crypto';
import { json } from '@sveltejs/kit';
import { checkIsMarkdownFilename } from '$lib/domain/markdownFilename';
import { readRequestBody } from '$lib/server/requestBody';
import type { CloudWriteResult } from '$lib/ports/cloudStorage';
import type { RequestHandler } from './$types';

// This raw-copy boundary is deliberately separate from the editor's v1 Save.
export const POST: RequestHandler = async ({ request, url, locals }) => {
  const reject = (status: number) =>
    json({ error: 'INVALID_COPY_REQUEST', outcome: 'not-written' }, { status });
  const path = url.searchParams.get('path');
  const create = request.headers.get('X-Create-Only');
  const hash = request.headers.get('X-Expected-Source-Hash');
  const revision = request.headers.get('X-Expected-Revision');
  if (
    !checkIsMarkdownFilename(path) ||
    (create !== null && create !== 'true' && create !== 'false') ||
    (create === 'true'
      ? hash !== null || revision !== null
      : !hash || !/^[a-f0-9]{64}$/.test(hash)) ||
    (revision !== null && (!revision.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(revision)))
  )
    return reject(400);
  const body = await readRequestBody(request, 'markdown');
  if (body.status !== 'success')
    return reject(
      body.status === 'too-large' ? 413 : body.status === 'unsupported-media-type' ? 415 : 400
    );
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    await body.response.arrayBuffer()
  );
  const storage = locals.cloudStorage;
  if (!storage)
    return json({ error: 'CLOUD_CONTEXT_MISMATCH', outcome: 'not-written' }, { status: 409 });
  let expectedRevision: string | undefined;
  try {
    const current = await storage.read(path);
    if (current.status === 'unavailable') return json({ ...current, outcome: 'not-written' });
    if (current.status === 'invalid') return json(current);
    if (create === 'true') {
      if (current.status !== 'not-found') return json({ status: 'conflict' });
    } else {
      if (
        current.status !== 'found' ||
        current.document.path !== path ||
        createHash('sha256').update(current.document.source, 'utf8').digest('hex') !== hash ||
        (revision !== null && current.document.revision !== revision)
      )
        return json({ status: 'conflict' });
      if (storage.getCapabilities().conditionalUpdate) {
        if (current.document.revision === null)
          return json({ status: 'unsupported', operation: 'conditional-update' });
        expectedRevision = current.document.revision;
      }
    }
  } catch {
    return json({ status: 'unavailable', reason: 'network', outcome: 'not-written' });
  }
  let result: CloudWriteResult;
  try {
    result = await storage.write({
      path,
      source,
      createOnly: create === 'true',
      ...(expectedRevision === undefined ? {} : { expectedRevision })
    });
  } catch {
    result = { status: 'unavailable', reason: 'network', outcome: 'unknown' };
  }
  return json(result);
};
