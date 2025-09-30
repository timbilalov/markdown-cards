import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../utils/markdownParser';
import { serializeCard } from '../utils/markdownSerializer';
import type { Card } from '../utils/markdownSerializer';

describe('markdownParser', () => {
  it('should parse basic card structure correctly', () => {
    const markdown = `# Test Card

## Data

### First Section

- Item 1
- Item 2

## Meta

### ID

test-card

### Created

2023-01-01

### Modified

2023-01-02`;

    const card = parseMarkdown(markdown);

    expect(card.title).toBe('Test Card');
    expect(card.meta.id).toBe('test-card');
    expect(card.sections.length).toBe(1);
    expect(card.sections[0].heading).toBe('First Section');
    expect(card.sections[0].items.length).toBe(2);
  });

  it('should handle single line descriptions correctly', () => {
    const markdown = `# Test Card

## Data

This is a single line description.

### Section

- Item

## Meta

### ID

test-card

### Created

2023-01-01

### Modified

2023-01-02`;

    const card = parseMarkdown(markdown);

    expect(card.description).toBe('This is a single line description.');
  });

  it('should preserve newlines in multiline descriptions', () => {
    const markdown = `# Test Card

## Data

This is paragraph 1.

This is paragraph 2 line 1.
This is paragraph 2 line 2.

### Section

- Item

## Meta

### ID

test-card

### Created

2023-01-01

### Modified

2023-01-02`;

    const card = parseMarkdown(markdown);

    // Check that newlines are preserved
    expect(card.description).toContain('This is paragraph 1.');
    expect(card.description).toContain('This is paragraph 2 line 1.');
    expect(card.description).toContain('This is paragraph 2 line 2.');

    // Check that there are appropriate line breaks
    const lines = card.description.split('\n');
    expect(lines.length).toBeGreaterThan(3); // Should have multiple lines
  });

  it('should handle empty lines in descriptions correctly', () => {
    const markdown = `# Test Card

## Data

First paragraph.

Second paragraph.

### Section

- Item

## Meta

### ID

test-card

### Created

2023-01-01

### Modified

2023-01-02`;

    const card = parseMarkdown(markdown);

    // Should preserve the empty line between paragraphs
    expect(card.description).toContain('First paragraph.\n\nSecond paragraph.');
  });

  it('should not include section content in description', () => {
    const markdown = `# Test Card

## Data

This is the description.

### Section Heading

- This should not be in description
- Another item

## Meta

### ID

test-card

### Created

2023-01-01

### Modified

2023-01-02`;

    const card = parseMarkdown(markdown);

    expect(card.description).toBe('This is the description.');
    expect(card.sections[0].items.length).toBe(2);
    expect(card.sections[0].items[0].text).toBe('This should not be in description');
  });

  it('should handle description with special characters', () => {
    const markdown = `# Test Card

## Data

Description with special characters: \`code\`, *italic*, **bold**.

And symbols like @#$%^&*().

### Section

- Item

## Meta

### ID

test-card

### Created

2023-01-01

### Modified

2023-01-02`;

    const card = parseMarkdown(markdown);

    expect(card.description).toContain('Description with special characters: `code`, *italic*, **bold**.');
    expect(card.description).toContain('And symbols like @#$%^&*().');
  });

  it('should handle description with markdown-like text', () => {
    const markdown = `# Test Card

## Data

Text that looks like markdown: # Not a title
## Not a section
- Not a list item

Actual section starts below.

### Real Section

- Actual list item

## Meta

### ID

test-card

### Created

2023-01-01

### Modified

2023-01-02`;

    const card = parseMarkdown(markdown);

    // The markdown-like text should be part of the description, not parsed as markdown
    expect(card.description).toContain('Text that looks like markdown: # Not a title');
    expect(card.description).toContain('## Not a section');
    expect(card.description).toContain('- Not a list item');
    expect(card.description).toContain('Actual section starts below.');

    // Only the actual section should be parsed as a section
    expect(card.sections.length).toBe(1);
    expect(card.sections[0].heading).toBe('Real Section');
    expect(card.sections[0].items[0].text).toBe('Actual list item');
  });

  it('should handle card with no description', () => {
    const markdown = `# Test Card

## Data

### Section

- Item

## Meta

### ID

test-card

### Created

2023-01-01

### Modified

2023-01-02`;

    const card = parseMarkdown(markdown);

    expect(card.description).toBe('');
    expect(card.sections.length).toBe(1);
  });

  it('should preserve newlines when serializing and parsing back', () => {
    // Create a card with multiline description
    const originalCard: Card = {
      title: 'Test Card',
      meta: {
        id: 'test-card',
        created: Date.now(),
        modified: Date.now()
      },
      description: 'First paragraph.\n\nSecond paragraph line 1.\nSecond paragraph line 2.',
      sections: [{
        heading: 'Section',
        type: 'unordered',
        items: [{ text: 'Item', checked: false }]
      }]
    };

    // Serialize to markdown
    const markdown = serializeCard(originalCard);

    // Parse back from markdown
    const parsedCard = parseMarkdown(markdown);

    // The description should be preserved
    expect(parsedCard.description).toBe(originalCard.description);
  });

  it('should handle edge case with trailing newlines', () => {
    const markdown = `# Test Card

## Data

Description with trailing newlines.


### Section

- Item

## Meta

### ID

test-card

### Created

2023-01-01

### Modified

2023-01-02`;

    const card = parseMarkdown(markdown);

    // Should handle trailing newlines appropriately
    expect(card.description).toContain('Description with trailing newlines.');
  });
});
