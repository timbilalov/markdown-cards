import { cloudService } from '$lib/services/cloudService';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request, url }) => {
  try {
    // Check if cloud service is authenticated (has access token)
    if (!cloudService.isAuthenticated()) {
      return new Response('Cloud service not configured', { status: 500 });
    }

    // Get file path from query parameters
    const filePath = url.searchParams.get('path');

    if (!filePath) {
      return new Response('Missing file path parameter', { status: 400 });
    }

    // Get the file download URL first
    const fileList = await cloudService.listFiles();
    const file = fileList._embedded.items.find(item => item.path === filePath);

    if (!file) {
      return new Response('File not found', { status: 404 });
    }

    // Check if file has a download link
    if (!file.file) {
      return new Response('File download link not available', { status: 500 });
    }

    // Download file content from Yandex Disk
    const content = await cloudService.downloadFile(file.file);

    // Return file content
    return new Response(content, {
      headers: {
        'Content-Type': 'text/plain',
        'Content-Disposition': `inline; filename="${file.name}"`
      }
    });
  } catch (error: any) {
    console.error('Error downloading file:', error);
    return new Response(`Error downloading file: ${error.message}`, { status: 500 });
  }
};

