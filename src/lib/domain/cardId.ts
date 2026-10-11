import type { CardIdParseResult } from './types';

export function parseCardId(input: unknown): CardIdParseResult {
  if (typeof input !== 'string' || input.length < 1 || input.length > 128
    || /[^A-Za-z0-9_-]/.test(input) || input === 'new') {
    return { status: 'invalid' };
  }
  return { status: 'success', id: input };
}
