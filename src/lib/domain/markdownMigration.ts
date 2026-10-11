import { parseMarkdownDocument, serializeMarkdownDocument } from './markdown';
import type {
  CardSection,
  MarkdownMigrationIssue,
  MarkdownMigrationPipelineResult,
  MarkdownMigrationResult,
  MarkdownMigrationStep,
  MarkdownMigrationStepResult,
  MarkdownMigrationTransition,
  MarkdownParseResult,
  MarkdownSerializeResult
} from './types';

function checkIsMigrationVersion(version: number): boolean {
  return Number.isSafeInteger(version) && version >= 0;
}

export function runMarkdownMigrations(input: {
  source: string;
  fromVersion: number;
  toVersion: number;
  steps: readonly MarkdownMigrationStep[];
}): MarkdownMigrationPipelineResult {
  const { source, fromVersion, toVersion, steps } = input;
  const invalidPath = { status: 'invalid', source, reason: 'invalid-migration-path' } as const;
  if (!checkIsMigrationVersion(fromVersion) || !checkIsMigrationVersion(toVersion)
    || fromVersion > toVersion) return invalidPath;

  const registry = new Map<number, MarkdownMigrationStep>();
  for (const step of steps) {
    if (!checkIsMigrationVersion(step.fromVersion) || !checkIsMigrationVersion(step.toVersion)
      || step.toVersion !== step.fromVersion + 1 || registry.has(step.fromVersion)) return invalidPath;
    registry.set(step.fromVersion, step);
  }

  // Resolve the complete path before calling a step, including when a later
  // link is missing. Lookup order never depends on the registry's array order.
  const path: MarkdownMigrationStep[] = [];
  for (let version = fromVersion; version < toVersion; version++) {
    const step = registry.get(version);
    if (!step) return invalidPath;
    path.push(step);
  }

  let markdown = source;
  const appliedSteps: MarkdownMigrationTransition[] = [];
  for (const step of path) {
    const result = step.migrate(markdown);
    if (result.status === 'invalid') return { status: 'invalid', source, reason: result.reason };
    if (result.status === 'unsupported') return { status: 'unsupported', source, reason: result.reason };
    markdown = result.markdown;
    appliedSteps.push({ fromVersion: step.fromVersion, toVersion: step.toVersion });
  }
  return { status: 'success', source, markdown, appliedSteps };
}

function toMigrationIssue(
  failure: Exclude<MarkdownParseResult | MarkdownSerializeResult, { status: 'success' }>
): MarkdownMigrationIssue {
  switch (failure.reason) {
    case 'missing-version':
      return { status: 'invalid', reason: 'invalid-version' };
    case 'invalid-card':
      return { status: 'invalid', reason: 'invalid-structure' };
    case 'unsupported-content':
    case 'unknown-version':
      return { status: 'unsupported', reason: failure.reason };
    default:
      return { status: 'invalid', reason: failure.reason };
  }
}

function inferLegacyListType(lines: readonly string[], start: number): CardSection['type'] {
  let index = start;
  while (index < lines.length && lines[index] === '') index++;
  const line = lines[index] ?? '';
  if (/^- \[[ xX]\] /.test(line)) return 'checklist';
  if (/^\d+\. /.test(line)) return 'ordered';
  // Empty lists use the legacy default. Unrecognized lines are left intact;
  // the strict parser will refuse them, not turn them into an empty list.
  return 'unordered';
}

function upgradeLegacySyntax(source: string): string {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const upgraded = ['<!-- markdown-cards: 1 -->', ''];
  let block = '';
  let metaField = '';
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    if (/^##(?: |$)/.test(line)) {
      block = line;
      metaField = '';
    }
    if (block === '## Meta') {
      if (line.startsWith('### ')) metaField = line.slice(4);
      if ((metaField === 'Created' || metaField === 'Modified') && /^\d{4}-\d{2}-\d{2}$/.test(line)) {
        // Calendar validity is checked by the v1 parser, using explicit UTC.
        line += 'T00:00:00.000Z';
      }
    }
    upgraded.push(line);
    if (block === '## Data' && line.startsWith('### ')) {
      upgraded.push(`<!-- list-type: ${inferLegacyListType(lines, index + 1)} -->`);
    }
  }
  return upgraded.join('\n');
}

function migrateLegacyToV1(source: string): MarkdownMigrationStepResult {
  // Rewrite only the known syntax differences. Every original line reaches
  // the strict codec; the permissive legacy parser is deliberately not used.
  const parsed = parseMarkdownDocument(upgradeLegacySyntax(source));
  if (parsed.status !== 'success') return toMigrationIssue(parsed);
  const serialized = serializeMarkdownDocument(parsed.document.card);
  return serialized.status === 'success' ? serialized : toMigrationIssue(serialized);
}

const migrations: readonly MarkdownMigrationStep[] = [
  { fromVersion: 0, toVersion: 1, migrate: migrateLegacyToV1 }
];

export function migrateMarkdownDocument(source: string): MarkdownMigrationResult {
  const current = parseMarkdownDocument(source);
  if (current.status === 'success') {
    return { status: 'success', source, document: current.document, appliedSteps: [] };
  }
  if (current.status !== 'unsupported' || current.reason !== 'missing-version') {
    return { ...toMigrationIssue(current), source };
  }

  const migrated = runMarkdownMigrations({ source, fromVersion: 0, toVersion: 1, steps: migrations });
  if (migrated.status !== 'success') return migrated;
  const parsed = parseMarkdownDocument(migrated.markdown);
  if (parsed.status !== 'success') return { ...toMigrationIssue(parsed), source };
  return { status: 'success', source, document: parsed.document, appliedSteps: migrated.appliedSteps };
}
