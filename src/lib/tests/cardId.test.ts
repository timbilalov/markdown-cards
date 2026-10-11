// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseCardId } from '../domain/cardId';

describe('Card id boundary: exact, path-safe identifiers', () => {
  it.each(['a', 'card-001', 'A_b-9', '_private', 'NEW', 'a'.repeat(128)])(
    'accepts %s without changing its spelling', id => {
      expect(parseCardId(id)).toEqual({ status: 'success', id });
    }
  );

  it.each([
    '', ' ', ' card-001', 'card-001 ', 'a b', '.', '..', '../card',
    'a/b', 'a\\b', '/absolute', 'disk:card', 'card.md', 'a?b', 'a#b',
    '%2e%2e', 'a\n', 'a\u0000b', 'карточка', 'a'.repeat(129), 'new',
    null, undefined, 42, true, {}, ['card-001']
  ].map(input => [input]))('rejects unsafe, reserved or non-string input %j', input => {
    expect(parseCardId(input)).toEqual({ status: 'invalid' });
  });
});
