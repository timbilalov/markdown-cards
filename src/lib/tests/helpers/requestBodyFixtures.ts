import { v1 } from './markdownReadFixtures';

// Proposed HTTP contract, deliberately independent of production constants.
export const loginBodyLimit = 16 * 1024;
export const uploadBodyLimit = 1024 * 1024;
export const inputCredentials = { username: 'test-user', password: 'cycle13-test-password' };
export const inputOrigin = 'https://app.example.invalid';
export const uploadFilename = 'existing-note.md'; // Not the Markdown meta.id.
export const initialInputRemote = { [`md-cards/${uploadFilename}`]: 'Original remote source' };
export const multipartBoundary = 'markdown-cards-input-test';
export const multipartType = `multipart/form-data; boundary=${multipartBoundary}`;
export const inputSource = v1.replace(/\r?\n/g, '\r\n');

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function loginBodyAtSize(bytes: number): string {
  const body = JSON.stringify(inputCredentials);
  return body + ' '.repeat(bytes - byteLength(body));
}

export function multipartBody(source = inputSource): string {
  return Object.entries({ path: uploadFilename, content: source, overwrite: 'true' })
    .map(([name, value]) => `--${multipartBoundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    .join('') + `--${multipartBoundary}--\r\n`;
}

export function uploadBodyAtSize(bytes: number, character = 'x'): { body: string; source: string } {
  const extra = bytes - byteLength(multipartBody());
  const width = byteLength(character);
  const padding = character.repeat(Math.floor(extra / width)) + 'x'.repeat(extra % width);
  const source = inputSource.replace('Первый абзац', padding + 'Первый абзац');
  return { source, body: multipartBody(source) };
}
