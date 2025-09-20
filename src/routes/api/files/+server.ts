import { json, type RequestHandler } from '@sveltejs/kit';
import { cloudService } from '$lib/services/cloudService';
import logger from '$lib/utils/logger';
import { dbService } from '$lib/services/dbService';

export const GET: RequestHandler = async ({ url, getClientAddress }) => {
  try {
    // Check if cloud service is authenticated (has access token)
    if (!cloudService.isAuthenticated()) {
      // If not authenticated, return empty array for backward compatibility
      return json([]);
    }

    cloudService.setBasePath('md-cards');

    // Try to fetch files from cloud
    const response = await cloudService.listFiles();
    const markdownFiles = response._embedded.items.filter(file => file.name.endsWith('.md'));

    // Extract just the filenames for backward compatibility
    const filenames = markdownFiles.map(file => file.name);

    // Log successful file listing
    logger.info('Files listed successfully', {
      count: filenames.length,
      ip: getClientAddress()
    });

    return json(filenames);
  } catch (error: any) {
    logger.error('Error reading markdown directory', {
      error: error.message,
      stack: error.stack,
      ip: getClientAddress()
    });
    return json([], { status: 500 });
  }
};
