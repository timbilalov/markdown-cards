export type CardId = string;

export interface CardSection {
  heading: string;
  type: 'unordered' | 'ordered' | 'checklist';
  items: {
    text: string;
    checked: boolean;
  }[];
}

export interface CardMeta {
  id: CardId;
  created: number;
  modified: number;
}

export interface Card {
  title: string;
  meta: CardMeta;
  description: string;
  status?: string;
  tags?: string[];
  image?: string;
  sections: CardSection[];
}

export type CardIdParseResult =
  | { status: 'success'; id: CardId }
  | { status: 'invalid' };

export interface MarkdownDocument {
  version: 1;
  source: string;
  card: Card;
}

export type MarkdownParseResult =
  | { status: 'success'; document: MarkdownDocument }
  | {
      status: 'unsupported';
      source: string;
      reason: 'missing-version' | 'unknown-version' | 'unsupported-content';
    }
  | {
      status: 'invalid';
      source: string;
      reason: 'invalid-version' | 'invalid-structure' | 'invalid-id' | 'invalid-timestamp';
    };

export type MarkdownSerializeResult =
  | { status: 'success'; markdown: string }
  | {
      status: 'invalid';
      reason: 'invalid-card' | 'invalid-id' | 'invalid-timestamp' | 'unsupported-content';
    };

// Version 0 denotes unversioned legacy Markdown only inside the migration API.
export interface MarkdownMigrationTransition {
  fromVersion: number;
  toVersion: number;
}

export type MarkdownMigrationIssue =
  | { status: 'unsupported'; reason: 'unknown-version' | 'unsupported-content' }
  | {
      status: 'invalid';
      reason: 'invalid-version' | 'invalid-structure' | 'invalid-id' | 'invalid-timestamp' | 'invalid-migration-path';
    };

export type MarkdownMigrationStepResult =
  | { status: 'success'; markdown: string }
  | MarkdownMigrationIssue;

export interface MarkdownMigrationStep extends MarkdownMigrationTransition {
  migrate: (source: string) => MarkdownMigrationStepResult;
}

export type MarkdownMigrationPipelineResult =
  | { status: 'success'; source: string; markdown: string; appliedSteps: MarkdownMigrationTransition[] }
  | (MarkdownMigrationIssue & { source: string });

export type MarkdownMigrationResult =
  | { status: 'success'; source: string; document: MarkdownDocument; appliedSteps: MarkdownMigrationTransition[] }
  | (MarkdownMigrationIssue & { source: string });

// Provider-issued identity, never a timestamp or a sortable version number.
// The policy treats null/empty values as unknown rather than a usable revision.
export type RemoteRevision = string;

export type RemoteBase =
  | { kind: 'present'; revision: RemoteRevision | null }
  | { kind: 'missing' }
  | { kind: 'unknown' };

// Display metadata only. It does not authorize writes or resolve sync conflicts.
export interface RemoteCardMetadata {
  filename: string;
  modified?: number;
}

export interface BoardCard {
  // File basename used by the route, independent of CardMeta.id.
  filename: string;
  title: string;
  modified?: number;
  source: 'indexeddb' | 'cloud' | 'filename' | 'mixed';
  status?: string;
  image?: string;
  readOnly?: true;
}

// Local display projection retains the file address independently of meta.id.
export interface BoardLocalCard extends Card { filename?: string; readOnly?: true }
export type BoardLocalEntry = BoardLocalCard | { filename: string; sourceOnly: true };

export interface BoardColumn {
  status: string;
  cards: BoardCard[];
}

export interface BoardProjection {
  cards: BoardCard[];
  refreshFilenames: string[];
}
