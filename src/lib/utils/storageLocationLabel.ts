export function storageFolderLabel(rootPath: string | undefined): string {
  return rootPath ?? 'Папка неизвестна';
}

export function storageLocationLabel(storage: { label: string; rootPath?: string }): string {
  return `${storage.label} · ${storageFolderLabel(storage.rootPath)}`;
}
