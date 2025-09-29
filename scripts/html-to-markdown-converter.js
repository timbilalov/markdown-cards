/**
 * IIFE HTML to Markdown Converter for Kaiten-like Cards
 * Converts HTML card content to clean markdown format
 */
(function() {
  'use strict';

  function parseRussianDate(dateString) {
    // Remove the "г." part (which means "года" - year)
    const cleanedString = dateString.replace(' г.,', '');

    // Russian month names mapping
    const months = {
      'января': 0,
      'февраля': 1,
      'марта': 2,
      'апреля': 3,
      'мая': 4,
      'июня': 5,
      'июля': 6,
      'августа': 7,
      'сентября': 8,
      'октября': 9,
      'ноября': 10,
      'декабря': 11
    };

    // Split the string to extract components
    const parts = cleanedString.split(' ');
    const day = parseInt(parts[0]);
    const month = months[parts[1]];
    const year = parseInt(parts[2]);

    // Split time part
    const timeParts = parts[3].split(':');
    const hours = parseInt(timeParts[0]);
    const minutes = parseInt(timeParts[1]);

    // Create date object
    const date = new Date(year, month, day);

    // Format as YYYY-MM-DD
    return date.toISOString().split('T')[0];
  }

  /**
   * Main converter function
   * @param {HTMLElement|String} cardElement - DOM element or selector string for the card
   * @returns {String} Markdown formatted string
   */
  function convertCardToMarkdown(cardElement) {
    try {
      // Handle selector string
      if (typeof cardElement === 'string') {
        cardElement = document.querySelector(cardElement);
      }

      if (!cardElement) {
        throw new Error('Card element not found');
      }

      console.log('Starting HTML to Markdown conversion...');

      // Initialize markdown output
      let markdown = '';

      // Extract card title
      const titleElement = cardElement.querySelector('[data-testid="card-title"]');
      const title = titleElement ? titleElement.textContent.trim() : 'Untitled Card';
      markdown += `# ${title}\n\n`;

      // Extract card ID and location
      const cardIdElement = cardElement.querySelector('[data-testid="card-id-in-card-header"]');
      let cardIdText = cardIdElement ? cardIdElement.textContent.trim() : '';
      if (cardIdText.startsWith('#')) {
        cardIdText = cardIdText.slice(1);
      }
      const cardId = cardIdElement ? 'card-' + cardIdText : '';

      // Extract creation date
      let creationDate = '';
      const accessTimeIcon = cardElement.querySelector('[data-testid="AccessTimeIcon"]');
      if (accessTimeIcon && accessTimeIcon.parentElement) {
        creationDate = accessTimeIcon.parentElement.getAttribute('aria-label') || '';
        // Clean up the date string if needed
        if (creationDate) {
          creationDate = parseRussianDate(creationDate).toLocaleString();
        }
      }

      // Extract card status
      let cardStatus = '';
      const locationPropertyLink = cardElement.querySelector('[data-testid="location-property-link"]');
      if (locationPropertyLink) {
        const locationText = locationPropertyLink.textContent.trim();
        const parts = locationText.split(' / ');
        if (parts.length >= 2) {
          cardStatus = parts[1].trim();
        }
      }

      markdown += `## Data\n\n`;

      // Add card status if available
      if (cardStatus) {
        markdown += `- **Status:** ${cardStatus}\n`;
      }

      // Extract tags/labels
      const tags = [];
      const tagElements = document.querySelectorAll('[data-testid="card-tag-title"]');
      tagElements.forEach(tag => {
        const tagText = tag.textContent.trim();
        if (tagText) tags.push(`#${tagText.replace(/\s+/g, '')}`);
      });

      if (tags.length > 0) {
        if (!cardId && !cardStatus) markdown += `## Data\n\n`;
        markdown += `- **Tags:** ${tags.join(' ')}\n`;
      }

      if (cardStatus || cardId || tegs.length > 0) {
        markdown += `\n`;
      }

      // Extract description
      const descriptionElement = cardElement.querySelector('[data-testid="card-description-editor"]');
      if (descriptionElement) {
        const descriptionText = extractTextWithFormatting(descriptionElement);
        if (descriptionText.trim()) {
          markdown += `${descriptionText.trim()}\n\n`;
        }
      }

      // Extract checklists
      const checklists = cardElement.querySelectorAll('[data-testid="checklist"]');
      checklists.forEach((checklist, index) => {
        // Get checklist title
        const checklistTitleElement = checklist.querySelector('[data-testid="card-title"]');
        const checklistTitle = checklistTitleElement ? checklistTitleElement.textContent.trim() : `Checklist ${index + 1}`;

        markdown += `### ${checklistTitle}\n\n`;

        // Extract checklist items
        const checklistItems = checklist.querySelectorAll('[data-testid="checklist-item"]');
        checklistItems.forEach(item => {
          const checkbox = item.querySelector('input[type="checkbox"]');
          const isChecked = checkbox && checkbox.checked;

          const itemTextElement = item.querySelector('[data-testid="checklist-item-title"] [data-testid]');
          if (itemTextElement) {
            let itemText = extractTextWithFormatting(itemTextElement);
            itemText = itemText.replace(/\n/g, ' ').trim();

            if (itemText) {
              // Temporary use a unordered lists, instead of checklists.
              if (isChecked) {
                // markdown += `- [x] ~~${itemText}~~\n`;
                markdown += `- ~~${itemText}~~\n`;
              } else {
                // markdown += `- [ ] ${itemText}\n`;
                markdown += `- ${itemText}\n`;
              }
            }
          }
        });

        markdown += `\n`;
      });

      markdown += `## Meta\n\n`;

      // Add Meta section with ID and creation date
      if (cardId) {
        markdown += `### ID\n\n`;
        markdown += `${cardId}\n\n`;
      }

      if (creationDate) {
        markdown += `### Created\n\n`;
        markdown += `${creationDate}\n\n`;
      }

      console.log('HTML to Markdown conversion completed successfully');
      return markdown.trim();
    } catch (error) {
      console.error('Error converting HTML to Markdown:', error);
      return `# Conversion Error\n\nFailed to convert card: ${error.message}`;
    }
  }

  /**
   * Extract text with formatting (bold, italic)
   * @param {HTMLElement} element - Element to extract text from
   * @returns {String} Formatted text
   */
  function extractTextWithFormatting(element) {
    if (!element) return '';

    let text = '';

    // Process child nodes to preserve formatting
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName.toLowerCase();

        // Handle bold text
        if (tagName === 'strong' || node.style.fontWeight === 'bold') {
          const innerText = extractTextWithFormatting(node);
          text += `**${innerText}**`;
        }
        // Handle italic text
        else if (tagName === 'em' || tagName === 'i' || node.style.fontStyle === 'italic') {
          const innerText = extractTextWithFormatting(node);
          text += `*${innerText}*`;
        }
        // Handle line breaks
        else if (tagName === 'br') {
          text += '\n';
        }
        // Handle paragraphs
        else if (tagName === 'p') {
          const innerText = extractTextWithFormatting(node);
          text += `${innerText}\n\n`;
        }
        // Recursively process other elements
        else {
          text += extractTextWithFormatting(node);
        }
      }
    }

    return text;
  }

  // Expose the function globally
  window.convertCardToMarkdown = convertCardToMarkdown;

  console.log('HTML to Markdown Converter loaded. Use convertCardToMarkdown(element) to convert a card.');

  // Example usage (commented out):
  // const markdown = convertCardToMarkdown('.cardModalContent');
  // console.log(markdown);
})();
