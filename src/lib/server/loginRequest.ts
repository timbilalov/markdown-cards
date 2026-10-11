import { checkIsUsername } from './session';

export interface LoginRequest {
  username?: string;
  password?: string;
  rememberMe?: boolean;
}

const allowedKeys = new Set(['username', 'password', 'rememberMe']);

function checkIsLoginRequest(value: unknown): value is LoginRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).every(key => allowedKeys.has(key))
    // Missing/empty credentials keep the route's existing required-field error.
    && (input.username === undefined || input.username === '' || checkIsUsername(input.username))
    && (input.password === undefined || (typeof input.password === 'string' && input.password.isWellFormed()))
    && (input.rememberMe === undefined || typeof input.rememberMe === 'boolean');
}

function checkHasUniqueTopLevelKeys(source: string): boolean {
  const keys = new Set<string>();
  let depth = 0;
  // JSON.parse has already checked the syntax. Consume whole string tokens so
  // escaped quotes/braces and key-like text inside values cannot become keys.
  for (const match of source.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]]/g)) {
    const token = match[0];
    if (token === '{' || token === '[') { depth++; continue; }
    if (token === '}' || token === ']') { depth--; continue; }
    if (depth !== 1) continue;

    let next = match.index + token.length;
    while (' \t\r\n'.includes(source[next] ?? '\0')) next++;
    if (source[next] !== ':') continue;
    const key: string = JSON.parse(token);
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

// The caller supplies the bounded response from readRequestBody, never a raw
// unbounded request. Keep native JSON/BOM handling, but reject invalid UTF-8.
export async function parseLoginRequest(body: Response): Promise<LoginRequest | null> {
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(await body.arrayBuffer());
    const input: unknown = JSON.parse(source);
    if (!checkIsLoginRequest(input) || !checkHasUniqueTopLevelKeys(source)) return null;
    return input;
  } catch {
    return null;
  }
}
