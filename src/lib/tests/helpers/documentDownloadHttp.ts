import type { CloudFile } from '../../types/cloud';
import type { mockHttp } from './http';

type Http = ReturnType<typeof mockHttp>;
type Responder = Parameters<Http['on']>[2];

// Historical file fixtures may contain provider URLs; downloads always use
// the filename. Register no ?url= alias that could hide a transport regression.
export function onDocumentDownload(http: Http, file: Pick<CloudFile, 'name'> & { file?: string }, respond: Responder): void {
  http.on('GET', `/api/cloud/download?path=${encodeURIComponent(file.name)}`, respond);
}
