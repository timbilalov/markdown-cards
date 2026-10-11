import { describe, expect, it } from 'vitest';
import { renderMarkdownPreview } from '../utils/markdownPreview';
import { v1 } from './helpers/markdownReadFixtures';

function render(source: string): HTMLDivElement {
  const html = renderMarkdownPreview(source);
  // Assert the public result before parsing it, so RED is not a TypeError.
  expect(html).toEqual(expect.any(String));
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

function expectNoActiveMarkup(root: HTMLElement) {
  expect(root.querySelector('script, style, iframe, object, embed, svg, math, form, meta, link, base')).toBeNull();
  for (const element of root.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      expect(attribute.name).not.toMatch(/^on/i);
      expect(['style', 'srcdoc', 'id', 'name', 'formaction', 'srcset']).not.toContain(attribute.name);
    }
  }
  expect(fetch).not.toHaveBeenCalled();
}

describe('Safe Markdown preview renderer — display policy, independent of the strict codec', () => {
  it.each([
    ['script', '<script>void 0</script>'],
    ['image event handler', '<img src="x" onerror="void 0">'],
    ['SVG namespace', '<svg><a xlink:href="javascript:void 0">raw</a></svg>'],
    ['embedded document', '<iframe srcdoc="<img src=x onerror=void(0)>"></iframe>'],
    ['form and DOM clobbering', '<form id="location" name="document"><input name="cookie"></form>'],
    ['otherwise harmless HTML', '<b title="raw">literal HTML</b>'],
    ['CSS and navigation', '<style>body{display:none}</style><meta http-equiv="refresh" content="0;url=/login">']
  ])('displays %s literally instead of interpreting raw HTML', (_name, payload) => {
    const root = render(`# Safe heading\n\n${payload}\n\nKeep **Markdown**.`);
    expect(root.querySelector('h1')?.textContent).toBe('Safe heading');
    expect(root.textContent).toContain(payload);
    expect(root.querySelector('strong')?.textContent).toBe('Markdown');
    expect(root.querySelector('b')).toBeNull();
    expectNoActiveMarkup(root);
  });

  it.each([
    ['JavaScript', 'javascript:void%200'],
    ['mixed case', 'JaVaScRiPt:void%200'],
    ['entity in scheme', 'jav&#x61;script:void%200'],
    ['entity colon', 'javascript&#58;void%200'],
    ['tab entity', 'java&#9;script:void%200'],
    ['newline entity', 'java&#10;script:void%200'],
    ['VBScript', 'vbscript:msgbox%200'],
    ['data document', 'data:text/html;base64,PGI+dGVzdDwvYj4='],
    ['blob', 'blob:https://example.invalid/test'],
    ['local file', 'file:///private/test'],
    ['unapproved scheme', 'ftp://example.invalid/test']
  ])('keeps the label but removes the navigable %s URL', (_name, href) => {
    const root = render(`Before [blocked **label**](${href}) after. [safe](https://example.invalid/ok)`);
    expect(root.textContent).toContain('Before blocked label after. safe');
    expect(root.querySelector('strong')?.textContent).toBe('label');
    expect([...root.querySelectorAll('a[href]')].map(a => a.getAttribute('href'))).toEqual([
      'https://example.invalid/ok'
    ]);
    expectNoActiveMarkup(root);
  });

  it.each([
    ['https', 'https://example.invalid/note?q=1&lang=ru'],
    ['http', 'http://example.invalid/note'],
    ['mail', 'mailto:user@example.invalid'],
    ['root relative', '/card/existing-note'],
    ['path relative', '../notes/item.md'],
    ['query', '?view=preview'],
    ['fragment', '#section'],
    ['protocol relative', '//example.invalid/note'],
    ['scheme text inside an HTTP path', '/docs/javascript:notes']
  ])('preserves a permitted %s link and its label', (_name, href) => {
    const root = render(`[Читать](${href})`);
    expect(root.querySelector('a')?.getAttribute('href')).toBe(href);
    expect(root.querySelector('a')?.textContent).toBe('Читать');
    expectNoActiveMarkup(root);
  });

  it.each([
    'javascript:void%200',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:image/png;base64,aGVsbG8=',
    'blob:https://example.invalid/image',
    'file:///private/image.png',
    'mailto:user@example.invalid'
  ])('removes disallowed image src %s while preserving nearby content', src => {
    const root = render(`Before ![image label](${src}) after. ![safe](https://example.invalid/ok.png)`);
    expect(root.textContent).toContain('Before');
    expect(root.textContent).toContain('after.');
    expect([...root.querySelectorAll('img[src]')].map(img => img.getAttribute('src'))).toEqual([
      'https://example.invalid/ok.png'
    ]);
    expectNoActiveMarkup(root);
  });

  it('preserves the v1 presentation, inert checkboxes, permitted images and line breaks', () => {
    const source = v1.replace('Второй абзац с `кодом`.', 'Второй абзац с `кодом`.\nЕщё строка.');
    const root = render(source);
    expect(root.querySelector('h1')?.textContent).toBe('Карточка 🗂');
    expect(root.querySelector('strong')?.textContent).toBe('Status:');
    expect(root.querySelector('code')?.textContent).toBe('кодом');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.invalid');
    expect(root.querySelector('img')?.getAttribute('src')).toBe('https://example.invalid/cover.png');
    expect(root.querySelector('br')).not.toBeNull();
    expect(root.querySelector('ul')).not.toBeNull();
    expect(root.querySelector('ol')).not.toBeNull();
    expect(root.querySelector('del')?.textContent).toBe('Готовый пункт');
    expect([...root.querySelectorAll<HTMLInputElement>('input')].map(input => ({
      type: input.type, checked: input.checked, disabled: input.disabled
    }))).toEqual([
      { type: 'checkbox', checked: false, disabled: true },
      { type: 'checkbox', checked: true, disabled: true }
    ]);
    expect(root.textContent).toContain('2026-09-25T12:34:56.789Z');
    expect(root.textContent).not.toContain('markdown-cards:');
    expect(root.textContent).not.toContain('list-type:');
    expect(root.innerHTML).not.toContain('<!--');
    expectNoActiveMarkup(root);
  });

  it.each(['http://example.invalid/image.png', '/images/card.png', '../image.png', '//example.invalid/image.png'])(
    'preserves a permitted image URL %s', src => {
      const root = render(`![Фото](${src})`);
      expect(root.querySelector('img')?.getAttribute('src')).toBe(src);
      expect(root.querySelector('img')?.getAttribute('alt')).toBe('Фото');
      expectNoActiveMarkup(root);
    });

  it('keeps escaped text and code literal, and quotes in a link title inside that attribute', () => {
    const root = render('`<img src=x onerror="void 0">` &lt;script&gt; &amp; '
      + '[ссылка](https://example.invalid "&quot; onmouseover=&quot;void 0")');
    expect(root.querySelector('code')?.textContent).toBe('<img src=x onerror="void 0">');
    expect(root.textContent).toContain('<script> & ссылка');
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('a')?.getAttribute('title')).toBe('" onmouseover="void 0');
    expectNoActiveMarkup(root);
  });
});
