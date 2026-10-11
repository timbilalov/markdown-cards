import { env } from '$env/dynamic/private';
import type { CloudStoragePort } from '../../ports/cloudStorage';
import { createCloudStorage } from './cloudStorageFactory';

// Server composition entry point. Runtime private env is read only when called.
export function createServerCloudStorage(): CloudStoragePort {
  return createCloudStorage({
    provider: env.CLOUD_STORAGE_PROVIDER,
    yandex: {
      accessToken: env.YANDEX_DISK_TOKEN ?? '',
      rootPath: env.YANDEX_DISK_BASE_PATH ?? ''
    }
  });
}
