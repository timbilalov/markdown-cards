import fs from 'fs/promises';
import path from 'path';
import { json } from '@sveltejs/kit';
import logger from '$lib/utils/logger';

export async function GET({ getClientAddress }) {
  try {
    const markdownDir = path.resolve('static/markdown');
    const files = await fs.readdir(markdownDir);
    // Filter only markdown files
    const markdownFiles = files.filter(file => file.endsWith('.md'));

    // Log successful file listing
    logger.info('Files listed successfully', {
      count: markdownFiles.length,
      ip: getClientAddress()
    });

    return json(markdownFiles);
  } catch (error: any) {
    logger.error('Error reading markdown directory', {
      error: error.message,
      stack: error.stack,
      ip: getClientAddress()
    });
    return json([], { status: 500 });
  }
}
