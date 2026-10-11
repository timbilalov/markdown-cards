import { parseCardId } from './cardId';
import { parseMarkdownTimestamp, validateMarkdownCard } from './markdownValidation';
import type { Card, CardMeta, CardSection, MarkdownParseResult, MarkdownSerializeResult } from './types';

type ParseProblem =
  | { status: 'invalid'; reason: 'invalid-structure' | 'invalid-id' | 'invalid-timestamp' }
  | { status: 'unsupported'; reason: 'unsupported-content' };
type CardData = Omit<Card, 'title' | 'meta'>;
const invalidStructure = { status: 'invalid', reason: 'invalid-structure' } as const;
const unsupportedContent = { status: 'unsupported', reason: 'unsupported-content' } as const;

function trimBlankLines(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start++;
  while (end > start && lines[end - 1] === '') end--;
  return lines.slice(start, end);
}

function parseMeta(lines: readonly string[]): { status: 'success'; meta: CardMeta } | ParseProblem {
  const fields = new Map<string, string>();
  const order = ['ID', 'Created', 'Modified'];
  let index = 0;
  while (index < lines.length) {
    if (lines[index] === '') { index++; continue; }
    const heading = /^### (.+)$/.exec(lines[index]);
    if (!heading) return invalidStructure;
    const name = heading[1];
    if (!order.includes(name)) return unsupportedContent;
    if (name !== order[fields.size] || fields.has(name)) return invalidStructure;
    const start = ++index;
    while (index < lines.length && !lines[index].startsWith('### ')) index++;
    const values = trimBlankLines(lines.slice(start, index));
    if (values.length > 1) return invalidStructure;
    fields.set(name, values[0] ?? '');
  }
  if (fields.size !== order.length) return invalidStructure;
  const id = parseCardId(fields.get('ID'));
  if (id.status !== 'success') return { status: 'invalid', reason: 'invalid-id' };
  const created = parseMarkdownTimestamp(fields.get('Created') ?? '');
  const modified = parseMarkdownTimestamp(fields.get('Modified') ?? '');
  if (created === null || modified === null) return { status: 'invalid', reason: 'invalid-timestamp' };
  return { status: 'success', meta: { id: id.id, created, modified } };
}

function parseItem(line: string, type: CardSection['type']):
  { status: 'success'; item: CardSection['items'][number] } | ParseProblem {
  const checklist = /^- \[([ xX])\] (.*)$/.exec(line);
  const unordered = /^- (.*)$/.exec(line);
  const ordered = /^\d+\. (.*)$/.exec(line);
  const actualType = checklist ? 'checklist' : unordered ? 'unordered' : ordered ? 'ordered' : null;
  if (actualType === null) return unsupportedContent;
  if (actualType !== type) return invalidStructure;
  let text = checklist ? checklist[2] : unordered ? unordered[1] : ordered ? ordered[1] : '';
  let checked = checklist ? checklist[1].toLowerCase() === 'x' : false;
  if (text.startsWith('~~') && text.endsWith('~~') && text.length >= 4) {
    if (checklist && !checked) return invalidStructure;
    checked = true;
    text = text.slice(2, -2);
  }
  return { status: 'success', item: { text, checked } };
}

function parseData(lines: readonly string[]): { status: 'success'; data: CardData } | ParseProblem {
  const data: CardData = { description: '', sections: [] };
  let index = 0;
  let metadataRank = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === '') { index++; continue; }
    if (line.startsWith('- **Status:**')) {
      if (metadataRank >= 1 || !line.startsWith('- **Status:** ')) return invalidStructure;
      data.status = line.slice('- **Status:** '.length);
      metadataRank = 1;
    } else if (line === '- **Tags:**' || line.startsWith('- **Tags:** ')) {
      if (metadataRank >= 2) return invalidStructure;
      const value = line.slice('- **Tags:**'.length).trim();
      const tags = value ? value.split(/\s+/) : [];
      if (tags.some(tag => !/^#[^#\s]+$/.test(tag))) return invalidStructure;
      data.tags = tags.map(tag => tag.slice(1));
      metadataRank = 2;
    } else if (line.startsWith('![](')) {
      if (metadataRank >= 3) return invalidStructure;
      const image = /^!\[\]\(([^\s()<>\\]+)\)$/.exec(line);
      if (!image) return unsupportedContent;
      data.image = image[1];
      metadataRank = 3;
    } else {
      break;
    }
    index++;
  }
  const descriptionStart = index;
  while (index < lines.length && !lines[index].startsWith('### ')) index++;
  data.description = trimBlankLines(lines.slice(descriptionStart, index)).join('\n');
  while (index < lines.length) {
    const heading = lines[index++].slice(4);
    const marker = /^<!-- list-type: (.+) -->$/.exec(lines[index++] ?? '');
    if (!heading.trim() || !marker) return invalidStructure;
    const type = marker[1];
    if (type !== 'unordered' && type !== 'ordered' && type !== 'checklist') return unsupportedContent;
    const section: CardSection = { heading, type, items: [] };
    while (index < lines.length && !lines[index].startsWith('### ')) {
      const line = lines[index++];
      if (line === '') continue;
      const parsed = parseItem(line, type);
      if (parsed.status !== 'success') return parsed;
      section.items.push(parsed.item);
    }
    data.sections.push(section);
  }
  return { status: 'success', data };
}

export function parseMarkdownDocument(source: string): MarkdownParseResult {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const version = /^<!-- markdown-cards: ([1-9]\d*) -->$/.exec(lines[0]);
  if (!version) {
    return lines.some(line => /<!--\s*markdown-cards\b/.test(line))
      ? { status: 'invalid', source, reason: 'invalid-version' }
      : { status: 'unsupported', source, reason: 'missing-version' };
  }
  if (version[1] !== '1') return { status: 'unsupported', source, reason: 'unknown-version' };
  if (lines.slice(1).some(line => /<!--\s*markdown-cards\b/.test(line))) {
    return { status: 'invalid', source, reason: 'invalid-version' };
  }

  const body = trimBlankLines(lines.slice(1));
  const title = /^# (.+)$/.exec(body[0] ?? '');
  if (!title || !title[1].trim()) return { ...invalidStructure, source };
  const content = trimBlankLines(body.slice(1));
  if (content[0] !== '## Data') return { ...invalidStructure, source };
  const metaIndex = content.indexOf('## Meta');
  if (metaIndex < 0) return { ...invalidStructure, source };
  for (let index = 1; index < content.length; index++) {
    const line = content[index];
    if (line === '## Data' || (line === '## Meta' && index !== metaIndex) || /^#(?: |$)/.test(line)) {
      return { ...invalidStructure, source };
    }
    if (/^##(?: |$)/.test(line) && line !== '## Meta') return { ...unsupportedContent, source };
  }
  const meta = parseMeta(content.slice(metaIndex + 1));
  if (meta.status !== 'success') return { ...meta, source };
  const data = parseData(content.slice(1, metaIndex));
  if (data.status !== 'success') return { ...data, source };
  const validated = validateMarkdownCard({ title: title[1], meta: meta.meta, ...data.data });
  if (validated.status !== 'success') {
    if (validated.reason === 'unsupported-content') return { ...unsupportedContent, source };
    return { status: 'invalid', source,
      reason: validated.reason === 'invalid-card' ? 'invalid-structure' : validated.reason };
  }
  return { status: 'success', document: { version: 1, source, card: validated.card } };
}

function writeCanonicalMarkdown(card: Card): string {
  const blocks = ['<!-- markdown-cards: 1 -->', `# ${card.title}`, '## Data'];
  const metadata: string[] = [];
  if (card.status !== undefined) metadata.push(`- **Status:** ${card.status}`);
  if (card.tags !== undefined) metadata.push(`- **Tags:**${card.tags.length ? ' ' + card.tags.map(tag => `#${tag}`).join(' ') : ''}`);
  if (metadata.length) blocks.push(metadata.join('\n'));
  if (card.image !== undefined) blocks.push(`![](${card.image})`);
  if (card.description !== '') blocks.push(card.description);
  for (const section of card.sections) {
    blocks.push(`### ${section.heading}\n<!-- list-type: ${section.type} -->`);
    if (section.items.length) blocks.push(section.items.map(item => {
      if (section.type === 'checklist') return `- [${item.checked ? 'x' : ' '}] ${item.text}`;
      const text = item.checked ? `~~${item.text}~~` : item.text;
      return `${section.type === 'ordered' ? '1.' : '-'} ${text}`;
    }).join('\n'));
  }
  blocks.push('## Meta', '### ID', card.meta.id,
    '### Created', new Date(card.meta.created).toISOString(),
    '### Modified', new Date(card.meta.modified).toISOString());
  return blocks.join('\n\n') + '\n';
}

export function serializeMarkdownDocument(input: unknown): MarkdownSerializeResult {
  const validated = validateMarkdownCard(input);
  if (validated.status !== 'success') return validated;
  const markdown = writeCanonicalMarkdown(validated.card);
  // Structural-looking text can be valid inline Markdown but ambiguous in this
  // file grammar. Both cards use the validator's fixed key order; require an
  // exact semantic round-trip before returning any text that a caller can save.
  const parsed = parseMarkdownDocument(markdown);
  if (parsed.status !== 'success' || JSON.stringify(parsed.document.card) !== JSON.stringify(validated.card)) {
    return { status: 'invalid', reason: 'unsupported-content' };
  }
  return { status: 'success', markdown };
}
