import { cloudService } from '$lib/services/cloudService';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
  try {
    // Check if cloud service is authenticated (has access token)
    if (!cloudService.isAuthenticated()) {
      return new Response('Cloud service not configured', { status: 500 });
    }

    // Get the file URL from query parameters
    const fileUrl = url.searchParams.get('url');

    if (!fileUrl) {
      return new Response('Missing required parameter: url', { status: 400 });
    }

    // Validate that the URL is a Yandex Disk URL
    if (!fileUrl.startsWith('https://') ||
        (!fileUrl.includes('disk.yandex.ru') &&
         !fileUrl.includes('disk.yandex.com') &&
         !fileUrl.includes('downloader.disk.yandex'))) {
      return new Response('Invalid file URL. Only Yandex Disk URLs are allowed.', { status: 400 });
    }

    // Download the file content using the cloud service
    // This will use the server-side token and won't have CORS issues
    const fileContent = await cloudService.downloadFile(fileUrl);

    // Return the file content
    return new Response(fileContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600' // Cache for 1 hour
      }
    });
  } catch (error: any) {
    console.error('Error downloading file:', error);
    return new Response(`Error downloading file: ${error.message}`, { status: 500 });
  }
};
