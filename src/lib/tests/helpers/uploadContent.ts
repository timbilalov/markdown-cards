// Native File in Node/browser; jsdom's File exposes FileReader instead of text().
export async function readUploadContent(form: FormData): Promise<string> {
  const value = form.get('content');
  if (typeof value === 'string') return value;
  if (!value) throw new Error('Missing upload content fixture');
  if (typeof value.text === 'function') return value.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(value);
  });
}
