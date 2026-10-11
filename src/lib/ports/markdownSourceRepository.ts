// Existing editor basename (without the final .md), independent of Card ID.
// Keep source verbatim even when its Markdown format cannot be edited.
export interface StoredMarkdownSource {
  filename: string;
  source: string;
}

export interface MarkdownSourceRepository {
  // Only absence returns null; storage failures reject.
  read(filename: string): Promise<StoredMarkdownSource | null>;
  // Fulfil only after commit. This remote-source cache is not a pending draft.
  write(document: Readonly<StoredMarkdownSource>): Promise<void>;
}
