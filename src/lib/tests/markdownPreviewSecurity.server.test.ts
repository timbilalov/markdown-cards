// @vitest-environment node
import { expect, it } from 'vitest';
import { renderMarkdownPreview } from '../utils/markdownPreview';

it('returns no HTML when no browser DOM is available, instead of bypassing sanitization on SSR', () => {
  expect(renderMarkdownPreview('# Heading\n\n[link](javascript:void%200)')).toBe('');
  expect(fetch).not.toHaveBeenCalled();
});
