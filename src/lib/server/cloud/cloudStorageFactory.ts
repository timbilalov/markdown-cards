import type { CloudStoragePort } from '../../ports/cloudStorage';
import { YandexDiskAdapter, type YandexDiskAdapterOptions } from './yandexDiskAdapter';

const configurationError = 'Invalid cloud storage configuration';

// Server configuration only. Provider selection never comes from a UI request.
export interface CloudStorageConfig {
  provider: string | undefined;
  yandex?: YandexDiskAdapterOptions;
}

export function createCloudStorage(config: CloudStorageConfig): CloudStoragePort {
  if (config.provider !== 'yandex' || config.yandex === undefined) {
    throw new Error(configurationError);
  }
  try {
    return new YandexDiskAdapter(config.yandex);
  } catch {
    // Keep constructor diagnostics and configuration values inside this boundary.
    throw new Error(configurationError);
  }
}
