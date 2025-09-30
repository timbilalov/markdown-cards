import type { Card } from './markdownSerializer';

export function parseMarkdown(markdown: string): Card {
  const lines = markdown.split('\n');
  const card: Card = {
    title: '',
    meta: {
      id: '',
      created: 0,
      modified: 0
    },
    description: '',
    status: undefined,
    tags: undefined,
    image: undefined,
    sections: []
  };

  let currentSection: Card['sections'][0] | null = null;
  let inDataSection = false;
  let inMetaSection = false;
  let currentMetaField: keyof Card['meta'] | null = null;
  let inDescription = true; // Start in description until we hit a section heading

  for (const line of lines) {
    if (!line.trim() && !inDescription) {
      continue;
    }

    // Parse title
    if (line.startsWith('# ') && !card.title) {
      card.title = line.substring(2).trim();
      continue;
    }

    // Start of data section
    if (line.startsWith('## Data')) {
      inDataSection = true;
      inMetaSection = false;
      currentMetaField = null;
      continue;
    }

    // Start of meta section
    if (line.startsWith('## Meta')) {
      inDataSection = false;
      inMetaSection = true;
      currentMetaField = null;
      inDescription = false; // No longer in description
      continue;
    }

    // Parse meta fields
    if (inMetaSection && line.startsWith('### ')) {
      const field = line.substring(4).trim().toLowerCase();
      if (field === 'id') currentMetaField = 'id';
      else if (field === 'created') currentMetaField = 'created';
      else if (field === 'modified') currentMetaField = 'modified';
      else currentMetaField = null;
      continue;
    }

    // Parse meta values
    if (inMetaSection && currentMetaField) {
      const value = line.trim();
      if (currentMetaField === 'id') {
        card.meta.id = value;
      } else if (currentMetaField === 'created' || currentMetaField === 'modified') {
        // Parse date string into timestamp
        const date = new Date(value);
        if (!isNaN(date.getTime())) {
          card.meta[currentMetaField] = date.getTime();
        }
      }
      currentMetaField = null;
      continue;
    }

    // Parse data section headings (now level 3)
    if (inDataSection && line.startsWith('### ')) {
      if (currentSection) {
        card.sections.push(currentSection);
      }
      currentSection = {
        heading: line.substring(4).trim(),
        type: 'unordered',
        items: []
      };
      inDescription = false; // No longer in description
      continue;
    }

    // Parse list items in data section
    if (inDataSection && currentSection) {
      let text = '';
      let checked = false;

      // Handle strikethrough for all list types
      if (line.includes('~~')) {
        const match = line.match(/~~(.*?)~~/);
        if (match) {
          text = match[1];
          checked = true;
        }
      }

      if (line.startsWith('- [x] ') || line.startsWith('- [X] ')) {
        currentSection.type = 'checklist';
        text = text || line.substring(6).trim();
        currentSection.items.push({ text, checked: true });
        continue;
      }

      if (line.startsWith('- [ ] ')) {
        currentSection.type = 'checklist';
        text = text || line.substring(6).trim();
        currentSection.items.push({ text, checked: false });
        continue;
      }

      if (line.startsWith('- ')) {
        currentSection.type = 'unordered';
        text = text || line.substring(2).trim();
        currentSection.items.push({ text, checked });
        continue;
      }

      if (line.match(/^\d+\.\s/)) {
        currentSection.type = 'ordered';
        text = text || line.replace(/^\d+\.\s/, '').trim();
        currentSection.items.push({ text, checked });
        continue;
      }
    }

    // Parse status, tags, and image in data section
    if (inDataSection && !currentSection && inDescription) {
      // Parse status
      if (line.startsWith('- **Status:**')) {
        card.status = line.substring(13).trim(); // Remove "- **Status:** " prefix
        continue;
      }

      // Parse tags
      if (line.startsWith('- **Tags:**')) {
        const tagsString = line.substring(11).trim(); // Remove "- **Tags:** " prefix
        card.tags = tagsString.split(/\s+/).map(tag => tag.startsWith('#') ? tag.substring(1) : tag).filter(tag => tag.length > 0);
        continue;
      }

      // Parse image
      if (line.match(/^!\[.*\]\(.*\)(\r)?$/)) {
        const match = line.match(/^!\[.*\]\((.*)\)(\r)?$/);
        if (match) {
          card.image = match[1];
        }
        continue;
      }

      // Parse description (only if it's not an empty line and we're still in description)
      if (line.trim() !== '') {
        card.description += line + '\n';
      } else if (card.description.trim() !== '') {
        // Add a newline for paragraph separation
        card.description += '\n';
      }
    }
  }

  // Add last section
  if (currentSection) {
    card.sections.push(currentSection);
  }

  card.description = card.description.trim();
  return card;
}
