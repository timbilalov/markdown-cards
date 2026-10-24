// Synthetic private credentials used only by the isolated in-memory provider worker.
export const multiStorageProduction = [
  {
    id: 'disk',
    label: 'Основной Диск',
    provider: 'yandex',
    accessToken: 'fixture-disk-private',
    rootPath: 'md-cards'
  },
  {
    id: 'dropbox',
    label: 'Dropbox резерв',
    provider: 'dropbox',
    appKey: 'fixture-app-key',
    appSecret: 'fixture-app-secret',
    refreshToken: 'fixture-refresh-token',
    rootPath: ''
  },
  {
    id: 'archive',
    label: 'Второй Диск',
    provider: 'yandex',
    accessToken: 'fixture-archive-private',
    rootPath: 'Archive'
  }
];
