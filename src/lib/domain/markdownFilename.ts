// One relative Markdown filename, including .md. Its nonempty basename is the
// editor route address; it may differ from the ID stored inside the document.
export function checkIsMarkdownFilename(value: unknown): value is string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length <= 3
    || !value.endsWith('.md') || /[\\/%:\u0000-\u001f\u007f]/.test(value)) return false;
  const basename = value.slice(0, -3);
  return basename !== '.' && basename !== '..';
}
