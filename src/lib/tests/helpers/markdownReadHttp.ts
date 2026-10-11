import { onDocumentDownload } from './documentDownloadHttp';
import type { CloudFile } from '../../types/cloud';
import { DAY, fileList, makeFile, NOW } from './fixtures';
import type { LegacyCloudFile } from './fixtures';
import { mockHttp } from './http';

export const cacheListUrl = 'https://cloud-api.yandex.net/v1/disk/resources?path=md-cards';

export function makeReadFile(overrides: Partial<LegacyCloudFile> = {}): LegacyCloudFile {
  // Different from both the cached timestamp and the v1 document's timestamp.
  return makeFile({ modified: new Date(NOW + DAY).toISOString(), ...overrides });
}

export function mockMarkdownReadHttp(documents: readonly { file: CloudFile; source: string }[]) {
  const http = mockHttp({ authenticated: true });
  const downloads: { filename: string; source: string }[] = [];
  const list = () => Response.json(fileList(documents.map(document => document.file)));
  http.on('GET', '/api/cloud/files', list);
  http.on('GET', cacheListUrl, list);
  for (const { file, source } of documents) {
    onDocumentDownload(http, file, () => {
      downloads.push({ filename: file.name, source });
      return new Response(source);
    });
  }
  // No upload handler: a write from these read paths fails assertHandled even
  // if production code catches the transport exception.
  return { http, downloads };
}
