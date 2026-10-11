import { readUploadContent } from './uploadContent';
import { onDocumentDownload } from './documentDownloadHttp';
import { fileList, makeFile, NOW } from './fixtures';
import { mockHttp } from './http';
import { installWebLocks } from './webLocks';

// Exercise the real new-card editor with a remote initially containing no file.
// Record attempts before replying so assertions cannot be swallowed by a catch.
export function mockNewCardDocumentHttp() {
  installWebLocks();
  const http = mockHttp({ authenticated: true });
  const uploads: { path: string; content: string; overwrite: FormDataEntryValue | null }[] = [];
  const files = new Map<string, string>();
  let failure: number | 'network' | null = null;
  http.on('GET', '/api/cloud/files', () => Response.json(fileList([...files.keys()].map(name =>
    makeFile({ name, modified: new Date(NOW + 60_000).toISOString(),
      path: `disk:/md-cards/${name}`, file: `https://downloader.disk.yandex.ru/${name}` })
  ))));
  http.on('POST', '/api/cloud/upload', async init => {
    const form = init?.body;
    if (!(form instanceof FormData)) throw new Error('Expected multipart upload');
    const upload = { path: String(form.get('path')), content: await readUploadContent(form), overwrite: form.get('overwrite') };
    uploads.push(upload);
    if (failure === 'network') throw new TypeError('Network unavailable');
    if (failure !== null) return new Response(null, { status: failure });
    if (files.has(upload.path) && upload.overwrite !== 'true') return new Response(null, { status: 409 });
    files.set(upload.path, upload.content);
    onDocumentDownload(http, { name: upload.path, file: `https://downloader.disk.yandex.ru/${upload.path}` }, () => new Response(files.get(upload.path)));
    return Response.json({ success: true });
  });
  return { http, uploads, files, setFailure(value: typeof failure) { failure = value; } };
}
