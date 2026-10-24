export function checkIsRegistryId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[^a-zA-Z0-9_-]/.test(value);
}

export function checkIsIdentityText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.isWellFormed() &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}

export function checkIsStorageContextId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 71 && /^ctx-v1-[a-f0-9]{64}$/.test(value);
}
