import { readUploadContent } from './uploadContent';
import { onDocumentDownload } from './documentDownloadHttp';
import { expect } from 'vitest';
import { fileList, makeFile, NOW } from './fixtures';
import { mockHttp } from './http';
import { installWebLocks } from './webLocks';

// A file name deliberately different from meta.id verifies that migration and
// Save update the opened file rather than create another one named after its ID.
export const documentSlug = 'existing-note';
export const documentFilename = `${documentSlug}.md`;

export function mockCardDocumentHttp(initialSource: string) {
  installWebLocks();
  const http = mockHttp({ authenticated: true });
  let source = initialSource;
  let modified = NOW + 60_000;
  const file = makeFile({ name: documentFilename, path: `disk:/md-cards/${documentFilename}` });
  const downloads: string[] = [];
  const uploads: { path: FormDataEntryValue | null; content: string; overwrite: FormDataEntryValue | null }[] = [];

  http.on('GET', '/api/cloud/files', () => Response.json(fileList([
    { ...file, modified: new Date(modified).toISOString() }
  ])));
  onDocumentDownload(http, file, () => {
    downloads.push(source);
    return new Response(source);
  });
  http.on('POST', '/api/cloud/upload', async init => {
    const form = init?.body;
    // Record transport data here; make behavioral assertions outside callbacks
    // so production catch blocks cannot swallow an assertion failure.
    if (!(form instanceof FormData)) throw new Error('Expected multipart upload');
    source = await readUploadContent(form);
    uploads.push({ path: form.get('path'), content: source, overwrite: form.get('overwrite') });
    modified++;
    return Response.json({ success: true });
  });

  return {
    http, downloads, uploads,
    readRemoteSource: () => source,
    // Force the old cache loader to consult the remote file on the next open.
    // This models a fresh remote read, without clearing the user's cache/outbox.
    advanceRemoteModifiedTime() { modified++; },
    assertUploaded(markdown: string) {
      expect(uploads).toEqual([{ path: documentFilename, content: markdown, overwrite: 'true' }]);
    }
  };
}
