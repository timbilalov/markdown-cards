import { createStorageContextId } from '../../server/cloud/storageRegistry';
import type { mockHttp } from './http';

const accountUrl = 'https://cloud-api.yandex.net/v1/disk?fields=user.uid';
export function fixtureStorageContext(root = 'md-cards') {
  return createStorageContextId('yandex', {
    provider: 'yandex',
    accountId: 'fixture-account',
    rootId: JSON.stringify(['fixture-folder', `disk:/${root}`])
  });
}

export function mockStorageIdentity(http: ReturnType<typeof mockHttp>, root = 'md-cards') {
  http.on('GET', accountUrl, () => Response.json({ user: { uid: 'fixture-account' } }));
  http.on(
    'GET',
    `https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(`disk:/${root}`)}&fields=type,path,resource_id`,
    () => Response.json({ type: 'dir', path: `disk:/${root}`, resource_id: 'fixture-folder' })
  );
  return fixtureStorageContext(root);
}

// Body/filename tests prohibit file I/O; identity verification now precedes body.
export function fileRequests(http: ReturnType<typeof mockHttp>) {
  return http.fetch.mock.calls.filter(
    ([url]) => String(url) !== accountUrl && !String(url).endsWith('&fields=type,path,resource_id')
  );
}
