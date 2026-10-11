import { vi } from 'vitest';

// Transition-only fixtures for the already approved regression suites. Exercise
// the old configuration when it exists; do not reintroduce it into the new API.
// No method, request, response or assertion is mocked/replaced here.
export function setLegacyClientToken(service: object, token: string | null): void {
  vi.stubEnv('VITE_YANDEX_DISK_TOKEN', token ?? '');
  const setter: unknown = Reflect.get(service, 'setAccessToken');
  if (typeof setter === 'function') setter.call(service, token);
}

export function setLegacyClientBasePath(service: object, path: string): void {
  vi.stubEnv('VITE_YANDEX_DISK_BASE_PATH', path);
  const setter: unknown = Reflect.get(service, 'setBasePath');
  if (typeof setter === 'function') setter.call(service, path);
}
