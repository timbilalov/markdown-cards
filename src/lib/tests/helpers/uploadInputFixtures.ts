import { inputSource } from './requestBodyFixtures';

export type UploadField = readonly [name: string, value: string | Blob];
export const uploadInputOrigin = 'https://app.example.invalid';
export const newFilename = 'new-note.md';
export const existingFilename = 'existing-note.md';
export const originalSource = 'Original source — must survive input refusal';
export const initialUploadRemote = { [`md-cards/${existingFilename}`]: originalSource };
export const unicodeFilename = ' Заметка 🗂 & планы #1?.md';

export function uploadFields(path = newFilename, overwrite: string | null = 'true', source = inputSource): UploadField[] {
  return [['path', path], ['content', source], ...(overwrite === null ? [] : [['overwrite', overwrite] as const])];
}

export function uploadForm(fields: readonly UploadField[]): FormData {
  const form = new FormData();
  for (const [name, value] of fields) form.append(name, value);
  return form;
}

export function uploadInputRequest(fields: readonly UploadField[], origin = uploadInputOrigin): Request {
  return new Request(`${uploadInputOrigin}/api/cloud/upload`, {
    method: 'POST', headers: { Origin: origin }, body: uploadForm(fields)
  });
}

// Serialize native multipart for the existing production worker's string-body
// interface. Preserve repeated fields and File parts without changing the worker.
export async function productionUploadBody(fields: readonly UploadField[]) {
  const request = uploadInputRequest(fields);
  return { body: await request.text(), contentType: request.headers.get('Content-Type')! };
}

export const unsafeUploadNames = [
  ['empty filename', ''], ['empty Markdown basename', '.md'], ['dot', '.'], ['parent dot', '..'],
  ['dot route basename', '..md'], ['parent route basename', '...md'],
  ['parent traversal', '../outside.md'], ['nested path', 'folder/note.md'],
  ['backslash', 'folder\\note.md'], ['absolute path', '/note.md'],
  ['colon in a filename', 'note:part.md'], ['literal percent', '100% done.md'],
  ['provider path', 'disk:/md-cards/note.md'], ['URL', 'https://example.invalid/note.md'],
  ['encoded slash', 'note%2fother.md'], ['double encoding', 'note%252fother.md'],
  ['NUL', 'bad\u0000.md'], ['line break', 'bad\n.md'], ['tab', 'bad\t.md'], ['DEL', 'bad\u007f.md'],
  ['other extension', 'note.txt'], ['uppercase extension', 'note.MD'],
  ['trailing space', 'note.md '], ['route alias without extension', 'new']
] as const;

export const ambiguousUploadFields: { name: string; fields: UploadField[] }[] = [
  { name: 'different paths', fields: [...uploadFields(), ['path', 'other-note.md']] },
  { name: 'identical paths', fields: [...uploadFields(), ['path', newFilename]] },
  { name: 'unsafe first path', fields: [...uploadFields('../outside.md'), ['path', newFilename]] },
  { name: 'file-valued first path', fields: [['path', new Blob(['private path'])], ...uploadFields()] },
  { name: 'valid content followed by legacy', fields: [...uploadFields(), ['content', '# legacy']] },
  { name: 'legacy content followed by valid', fields: [...uploadFields(newFilename, 'true', '# legacy'), ['content', inputSource]] },
  { name: 'identical contents', fields: [...uploadFields(), ['content', inputSource]] },
  { name: 'extra file-valued content', fields: [...uploadFields(), ['content', new Blob(['private extra file'])]] },
  { name: 'file-valued first content', fields: [['content', new Blob([inputSource])], ...uploadFields()] },
  { name: 'overwrite true then false', fields: [...uploadFields(), ['overwrite', 'false']] },
  { name: 'overwrite false then true', fields: [...uploadFields(newFilename, 'false'), ['overwrite', 'true']] },
  { name: 'identical overwrite values', fields: [...uploadFields(), ['overwrite', 'true']] }
];
