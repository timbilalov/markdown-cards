export interface CardSection {
  heading: string;
  type: 'unordered' | 'ordered' | 'checklist';
  items: {
    text: string;
    checked: boolean;
  }[];
}

export interface CardMeta {
  id: string;
  created: number; // Timestamp
  modified: number; // Timestamp
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

export function serializeCard(card: Card): string {
  let markdown = `# ${card.title}\n\n`;

  // Add data section first
  markdown += `## Data\n\n`;

  // Add status if it exists
  if (card.status) {
    markdown += `- **Status:** ${card.status}\n`;
  }

  // Add tags if they exist
  if (card.tags && card.tags.length > 0) {
    markdown += `- **Tags:** ${card.tags.map(tag => `#${tag}`).join(' ')}\n`;
  }

  // Add a blank line if we have status or tags
  if (card.status || (card.tags && card.tags.length > 0)) {
    markdown += `\n`;
  }

  // Add image if it exists
  if (card.image) {
    markdown += `![](${card.image})\n\n`;
  }

  markdown += `${card.description}\n\n`;

  card.sections.forEach(section => {
    // Use level 3 headings for data section
    markdown += `### ${section.heading}\n\n`;
    section.items.forEach(item => {
      let prefix = '';
      let text = item.text;

      // Add strikethrough for checked items in all list types
      if (item.checked) {
        text = `~~${text}~~`;
      }

      if (section.type === 'unordered') prefix = '- ';
      if (section.type === 'ordered') prefix = '1. ';
      if (section.type === 'checklist') prefix = item.checked ? '- [x] ' : '- [ ] ';

      markdown += `${prefix}${text}\n`;
    });
    markdown += '\n';
  });

  // Add meta section at the end
  markdown += `## Meta\n\n`;
  markdown += `### ID\n\n${card.meta.id}\n\n`;
  markdown += `### Created\n\n${new Date(card.meta.created).toISOString().split('T')[0]}\n\n`;
  markdown += `### Modified\n\n${new Date(card.meta.modified).toISOString().split('T')[0]}`;

  return markdown;
}

