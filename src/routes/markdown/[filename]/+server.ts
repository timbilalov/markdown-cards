import logger from '$lib/utils/logger';
import { cloudService } from '$lib/services/cloudService';
import { dbService } from '$lib/services/dbService';
import { parseMarkdown } from '$lib/utils/markdownParser';
import type { RequestHandler } from '@sveltejs/kit';

export const GET: RequestHandler = async ({ params, url, getClientAddress }) => {
  try {
    const filename = params.filename;

    // Verify that the file exists and is a markdown file
    if (!filename || !filename.endsWith('.md')) {
      return new Response('Not Found', { status: 404 });
    }

    // If cloud service is authenticated, try to fetch from cloud
    if (cloudService.isAuthenticated()) {
      try {
        cloudService.setBasePath('md-cards');

        // Get file list to find the specific file
        const fileList = await cloudService.listFiles();
        const file = fileList._embedded.items.find(item => item.name === filename);

        if (file && file.file) {
          // Download the file content
          const content = await cloudService.downloadFile(file.file);

          // Cache locally
          try {
            const card = parseMarkdown(content);
            await dbService.saveCard(card);
          } catch (cacheError) {
            console.error('Error caching file locally:', cacheError);
          }

          // Log successful file access
          logger.info('Markdown file accessed from cloud', {
            filename,
            ip: getClientAddress()
          });

          // Return the file content
          return new Response(content, {
            headers: {
              'Content-Type': 'text/markdown'
            }
          });
        }
      } catch (cloudError) {
        console.error('Error fetching from cloud:', cloudError);
        // Fall through to local cache if cloud fails
      }
    }

    // Try to get from local cache
    try {
      const cardId = filename.replace('.md', '');
      const card = await dbService.getCard(cardId);

      if (card) {
        // Convert card back to markdown
        const { serializeCard } = await import('$lib/utils/markdownSerializer');
        const content = serializeCard(card);

        // Log successful file access
        logger.info('Markdown file accessed from local cache', {
          filename,
          ip: getClientAddress()
        });

        // Return the file content
        return new Response(content, {
          headers: {
            'Content-Type': 'text/markdown'
          }
        });
      }
    } catch (cacheError) {
      console.error('Error reading from local cache:', cacheError);
    }

    // If we get here, file not found
    return new Response('Not Found', { status: 404 });
  } catch (error: any) {
    logger.error('Error reading markdown file', {
      error: error.message,
      stack: error.stack,
      ip: getClientAddress()
    });
    return new Response('Not Found', { status: 404 });
  }
};
