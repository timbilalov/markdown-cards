import fs from 'fs/promises';
import path from 'path';
import logger from '$lib/utils/logger';

export async function GET({ params, getClientAddress }) {
  try {
    const filename = params.filename;
    const filePath = path.resolve('static/markdown', filename);

    // Verify that the file exists and is a markdown file
    if (!filename.endsWith('.md')) {
      return new Response('Not Found', { status: 404 });
    }

    // Read the file
    const content = await fs.readFile(filePath, 'utf8');

    // Log successful file access
    logger.info('Markdown file accessed', {
      filename,
      ip: getClientAddress()
    });

    // Return the file content
    return new Response(content, {
      headers: {
        'Content-Type': 'text/markdown'
      }
    });
  } catch (error: any) {
    logger.error('Error reading markdown file', {
      error: error.message,
      stack: error.stack,
      ip: getClientAddress()
    });
    return new Response('Not Found', { status: 404 });
  }
}
