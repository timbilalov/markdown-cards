import fs from 'fs/promises';
import path from 'path';
import { json } from '@sveltejs/kit';
import { parseMarkdown } from '$lib/utils/markdownParser';
import logger from '$lib/utils/logger';

export async function POST({ request, getClientAddress }) {
  try {
    const { filename, content } = await request.json();
    let filePath = path.resolve('static/markdown', filename);
    let finalFilename = filename;

    // If filename is 'new', generate a new filename based on the card ID
    if (filename === 'new') {
      // Parse the content to extract the ID
      const card = parseMarkdown(content);
      const id = card.meta.id;

      // Use the ID as the filename
      finalFilename = `${id}.md`;
      filePath = path.resolve('static/markdown', finalFilename);
    }

    await fs.writeFile(filePath, content, 'utf8');

    // Log successful save
    logger.info('Card saved successfully', {
      filename: finalFilename,
      ip: getClientAddress()
    });

    return json({ success: true });
  } catch (error: any) {
    logger.error('Error saving file', {
      error: error.message,
      stack: error.stack,
      ip: getClientAddress()
    });
    return json({ success: false }, { status: 500 });
  }
}

