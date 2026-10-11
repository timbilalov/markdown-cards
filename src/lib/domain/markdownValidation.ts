import { Lexer, type Token } from 'marked';
import { parseCardId } from './cardId';
import type { Card, CardSection, MarkdownSerializeResult } from './types';

type CardValidationResult =
  | { status: 'success'; card: Card }
  | Exclude<MarkdownSerializeResult, { status: 'success' }>;

const firstTimestamp = Date.parse('0000-01-01T00:00:00.000Z');
const lastTimestamp = Date.parse('9999-12-31T23:59:59.999Z');

function checkIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkHasAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key));
}

function checkIsNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function checkIsTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= firstTimestamp && value <= lastTimestamp;
}

export function parseMarkdownTimestamp(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || match[0] !== value) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const [year, month, day, hour, minute, second] =
    [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || hour > 23 || minute > 59 || second > 59) return null;
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return null;
  const timestamp = Date.parse(value);
  return checkIsTimestamp(timestamp) ? timestamp : null;
}

function checkAreAllInlineTokensSupported(tokens: readonly Token[]): boolean {
  return tokens.every(token => {
    switch (token.type) {
      case 'text':
      case 'strong':
      case 'em':
      case 'link':
        return !token.tokens || checkAreAllInlineTokensSupported(token.tokens);
      case 'escape':
      case 'codespan':
      case 'br':
        return true;
      default:
        return false;
    }
  });
}

function checkHasAllowedTextCharacters(text: string): boolean {
  return !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text);
}

function checkIsSupportedInlineText(text: string): boolean {
  return !text.includes('\n') && checkHasAllowedTextCharacters(text)
    && checkAreAllInlineTokensSupported(Lexer.lexInline(text, { gfm: true }));
}

function checkIsSupportedDescription(text: string): boolean {
  return checkHasAllowedTextCharacters(text) && Lexer.lex(text, { gfm: true }).every(token =>
    token.type === 'space' || (token.type === 'paragraph' && checkAreAllInlineTokensSupported(token.tokens ?? [])));
}

// Build a typed snapshot only after every field has been checked. Unknown keys
// are rejected rather than silently omitted from a file written by the editor.
export function validateMarkdownCard(input: unknown): CardValidationResult {
  const invalidCard = { status: 'invalid', reason: 'invalid-card' } as const;
  const unsupportedContent = { status: 'invalid', reason: 'unsupported-content' } as const;
  if (!checkIsRecord(input) || !checkHasAllowedKeys(input, ['title', 'meta', 'description', 'status', 'tags', 'image', 'sections'])
    || !checkIsNonemptyString(input.title) || typeof input.description !== 'string'
    || !checkIsRecord(input.meta) || !checkHasAllowedKeys(input.meta, ['id', 'created', 'modified'])
    || !Array.isArray(input.sections)) return invalidCard;

  const id = parseCardId(input.meta.id);
  if (id.status !== 'success') return { status: 'invalid', reason: 'invalid-id' };
  if (!checkIsTimestamp(input.meta.created) || !checkIsTimestamp(input.meta.modified)) {
    return { status: 'invalid', reason: 'invalid-timestamp' };
  }
  if (!checkIsSupportedInlineText(input.title) || !checkIsSupportedDescription(input.description)) return unsupportedContent;

  const card: Card = {
    title: input.title,
    meta: { id: id.id, created: input.meta.created, modified: input.meta.modified },
    description: input.description,
    sections: []
  };
  if (input.status !== undefined) {
    if (!checkIsNonemptyString(input.status)) return invalidCard;
    if (!checkIsSupportedInlineText(input.status)) return unsupportedContent;
    card.status = input.status;
  }
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) return invalidCard;
    card.tags = [];
    for (const tag of input.tags) {
      if (typeof tag !== 'string' || !tag || /[\s#]/.test(tag)) return invalidCard;
      if (!checkIsSupportedInlineText(tag)) return unsupportedContent;
      card.tags.push(tag);
    }
  }
  if (input.image !== undefined) {
    if (!checkIsNonemptyString(input.image)) return invalidCard;
    if (/[\s()<>\\]/.test(input.image) || !checkHasAllowedTextCharacters(input.image)) return unsupportedContent;
    card.image = input.image;
  }
  for (const section of input.sections) {
    if (!checkIsRecord(section) || !checkHasAllowedKeys(section, ['heading', 'type', 'items'])
      || !checkIsNonemptyString(section.heading) || !Array.isArray(section.items)
      || (section.type !== 'unordered' && section.type !== 'ordered' && section.type !== 'checklist')) {
      return invalidCard;
    }
    if (!checkIsSupportedInlineText(section.heading)) return unsupportedContent;
    const parsedSection: CardSection = { heading: section.heading, type: section.type, items: [] };
    for (const item of section.items) {
      if (!checkIsRecord(item) || !checkHasAllowedKeys(item, ['text', 'checked'])
        || typeof item.text !== 'string' || typeof item.checked !== 'boolean') return invalidCard;
      if (!checkIsSupportedInlineText(item.text)) return unsupportedContent;
      parsedSection.items.push({ text: item.text, checked: item.checked });
    }
    card.sections.push(parsedSection);
  }
  return { status: 'success', card };
}
