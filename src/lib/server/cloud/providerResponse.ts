type ResponseBytesResult =
  | { status: 'success'; bytes: Uint8Array<ArrayBuffer> }
  | { status: 'too-large' | 'unreadable' };

type ResponseJsonResult =
  | { status: 'success'; value: unknown; byteLength: number }
  | { status: 'invalid' };

// Count bytes before decoding or parsing. A fixed buffer bounds retained chunks
// even when the peer sends many tiny chunks or understates Content-Length.
export async function readResponseBytes(response: Response, limit: number): Promise<ResponseBytesResult> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const declaredLength = response.headers.get('Content-Length');
    if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > limit) {
      void response.body?.cancel().catch(() => {});
      return { status: 'too-large' };
    }

    reader = response.body?.getReader();
    if (!reader) return { status: 'success', bytes: new Uint8Array(0) };
    const bytes = new Uint8Array(limit);
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { status: 'success', bytes: bytes.subarray(0, length) };
      if (value.byteLength > limit - length) {
        // Do not drain the body or wait for a slow/failed cancellation.
        void reader.cancel().catch(() => {});
        return { status: 'too-large' };
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } catch {
    return { status: 'unreadable' };
  } finally {
    reader?.releaseLock();
  }
}

function checkHasUniqueObjectKeys(source: string): boolean {
  const objects: Set<string>[] = [];
  // JSON.parse has already validated syntax. Scan complete string tokens and
  // object boundaries, without recursion; array values cannot be object keys.
  for (let index = 0; index < source.length; index++) {
    const token = source[index];
    if (token === '{') { objects.push(new Set()); continue; }
    if (token === '}') { objects.pop(); continue; }
    if (token !== '"') continue;

    let end = index + 1;
    while (source[end] !== '"') {
      // An escaped quote/backslash is part of this token, not a boundary.
      end += source[end] === '\\' ? 2 : 1;
    }
    let next = end + 1;
    while (' \t\r\n'.includes(source[next] ?? '\0')) next++;
    const keys = objects[objects.length - 1];
    if (source[next] === ':' && keys) {
      const key: string = JSON.parse(source.slice(index, end + 1));
      if (keys.has(key)) return false;
      keys.add(key);
    }
    index = end;
  }
  return true;
}

export async function readResponseJson(response: Response, limit: number): Promise<ResponseJsonResult> {
  const body = await readResponseBytes(response, limit);
  if (body.status !== 'success') return { status: 'invalid' };
  try {
    // Match native JSON BOM handling, but never repair malformed UTF-8.
    const source = new TextDecoder('utf-8', { fatal: true }).decode(body.bytes);
    const value: unknown = JSON.parse(source);
    if (!checkHasUniqueObjectKeys(source)) return { status: 'invalid' };
    return { status: 'success', value, byteLength: body.bytes.byteLength };
  } catch {
    return { status: 'invalid' };
  }
}
