import createDOMPurify from 'dompurify';
import { Marked } from 'marked';

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// This instance cannot change the lexer settings used by the strict file codec.
const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }) {
      // Version/list comments are metadata, never preview content.
      return text.trimStart().startsWith('<!--') ? '' : escapeHtml(text);
    }
  }
});

const attributesByTag: Record<string, readonly string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title'],
  ol: ['start'],
  input: ['type', 'checked', 'disabled']
};

function checkIsAllowedUrl(value: string, tag: string): boolean {
  try {
    // DOMPurify supplies entity-decoded attributes. URL also handles browser
    // scheme normalization (case, tabs/newlines), without rewriting the source.
    const { protocol } = new URL(value, 'https://markdown-preview.invalid/');
    return protocol === 'https:' || protocol === 'http:' || (tag === 'a' && protocol === 'mailto:');
  } catch {
    return false;
  }
}

// Own the hooks/configuration; do not mutate DOMPurify's shared default instance.
const purifier = typeof window === 'undefined' ? null : createDOMPurify(window);
if (purifier?.isSupported) {
  purifier.addHook('uponSanitizeElement', node => {
    if (node instanceof window.HTMLInputElement) {
      node.setAttribute('type', 'checkbox');
      node.setAttribute('disabled', '');
    }
  });
  purifier.addHook('uponSanitizeAttribute', (node, attribute) => {
    const tag = node.nodeName.toLowerCase();
    if (!attributesByTag[tag]?.includes(attribute.attrName)
      || ((attribute.attrName === 'href' || attribute.attrName === 'src')
        && !checkIsAllowedUrl(attribute.attrValue, tag))) {
      attribute.keepAttr = false;
    }
  });
}

/** Render display-only Markdown as safe HTML; without supported sanitization, render nothing. */
export function renderMarkdownPreview(source: string): string {
  if (!purifier?.isSupported) return '';
  const html = markdown.parse(source, { async: false });
  // Sanitization is the last operation before the component's HTML sink.
  return purifier.sanitize(html, {
    ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'strong', 'em', 'del',
      'ul', 'ol', 'li', 'input', 'br', 'hr', 'img', 'a', 'code'],
    ALLOWED_ATTR: Object.values(attributesByTag).flat(),
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_TRUSTED_TYPE: false
  });
}
