import { json, type RequestHandler } from '@sveltejs/kit';
import { parseMarkdown } from '$lib/utils/markdownParser';
import { serializeCard } from '$lib/utils/markdownSerializer';
import logger from '$lib/utils/logger';
import { cloudService } from '$lib/services/cloudService';
import { dbService } from '$lib/services/dbService';

export const POST: RequestHandler = async ({ request, url, getClientAddress }) => {
  try {
    // Get filename and content from request body
    const { filename, content } = await request.json();
    let finalFilename = filename;

    // If filename is 'new', generate a new filename based on the card ID
    if (filename === 'new') {
      // Parse the content to extract the ID
      const card = parseMarkdown(content);
      const id = card.meta.id;

      // Use the ID as the filename
      finalFilename = `${id}.md`;
    }

    // Save to local cache first
    try {
      const card = parseMarkdown(content);
      await dbService.saveCard(card);
    } catch (localError) {
      console.error('Error saving to local cache:', localError);
    }

    // If cloud service is authenticated, save to cloud as well
    if (cloudService.isAuthenticated()) {
      try {
        cloudService.setBasePath('md-cards');
        await cloudService.uploadFileAtPath(finalFilename, content);
      } catch (cloudError) {
        console.error('Error saving to cloud:', cloudError);
        // If cloud save fails but we're authenticated, this is an error
        throw cloudError;
      }
    }

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
};


