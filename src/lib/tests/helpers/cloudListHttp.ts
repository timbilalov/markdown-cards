import type { mockHttp } from './http';

type Http = ReturnType<typeof mockHttp>;
type Responder = Parameters<Http['on']>[2];

// Register the application's listing endpoint with an explicit response.
export function onCloudFileList(http: Http, respond: Responder): void {
  http.on('GET', '/api/cloud/files', respond);
}
