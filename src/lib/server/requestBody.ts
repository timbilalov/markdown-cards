import { MIMEType } from 'node:util';
import { isUtf8 } from 'node:buffer';

type RequestBodyFormat = 'json' | 'multipart';
type RequestBodyResult =
  | { status: 'success'; response: Response }
  | { status: 'unsupported-media-type' | 'too-large' | 'invalid' };

const bodyLimits: Record<RequestBodyFormat, number> = {
  json: 16 * 1024,
  multipart: 1024 * 1024
};

function parseContentType(request: Request, format: RequestBodyFormat): MIMEType | null {
  const encoding = request.headers.get('Content-Encoding');
  if (encoding !== null && encoding.toLowerCase() !== 'identity') return null;

  try {
    const type = new MIMEType(request.headers.get('Content-Type') ?? '');
    if (format === 'json') {
      const charset = type.params.get('charset');
      if (type.essence !== 'application/json' || (charset !== null && charset.toLowerCase() !== 'utf-8')) return null;
    } else if (type.essence !== 'multipart/form-data') {
      return null;
    }
    return type;
  } catch {
    return null;
  }
}

// Keep native JSON/FormData parsing, but only give it a body that fits the limit.
// Auth and Origin checks run in hooks before either caller reaches this reader.
export async function readRequestBody(request: Request, format: RequestBodyFormat): Promise<RequestBodyResult> {
  const contentType = parseContentType(request, format);
  if (contentType === null) return { status: 'unsupported-media-type' };

  const limit = bodyLimits[format];
  const declaredLength = request.headers.get('Content-Length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > limit) {
    return { status: 'too-large' };
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = request.body?.getReader();
    // A single bounded buffer also avoids retaining an unbounded list of chunks.
    const bytes = new Uint8Array(limit);
    let length = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength > limit - length) {
          // Do not drain the body or let slow/failed cancellation delay the 413.
          void reader.cancel().catch(() => {});
          return { status: 'too-large' };
        }
        bytes.set(value, length);
        length += value.byteLength;
      }
    }
    const body = bytes.subarray(0, length);
    // Upload accepts UTF-8 text, including the exact-byte Markdown file part.
    // Validate the original bounded bytes
    // before native FormData decoding can repair them into a different value.
    if (format === 'multipart' && !isUtf8(body)) return { status: 'invalid' };

    return {
      status: 'success',
      response: new Response(body, {
        headers: { 'Content-Type': contentType.toString() }
      })
    };
  } catch {
    return { status: 'invalid' };
  } finally {
    reader?.releaseLock();
  }
}
