import { cloudService } from '$lib/services/cloudService';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  try {
    // Check if cloud service is authenticated (has access token)
    if (!cloudService.isAuthenticated()) {
      return new Response('Cloud service not configured', { status: 500 });
    }

    // Get file data from request body
    const formData = await request.formData();
    const filePath = formData.get('path') as string;
    const fileContent = formData.get('content') as string;
    const overwrite = formData.get('overwrite') === 'true';

    if (!filePath || !fileContent) {
      return new Response('Missing required parameters: path and content', { status: 400 });
    }

    // Upload file to Yandex Disk
    await cloudService.uploadFileAtPath(filePath, fileContent, overwrite);

    return new Response('File uploaded successfully', { status: 200 });
  } catch (error: any) {
    console.error('Error uploading file:', error);
    return new Response(`Error uploading file: ${error.message}`, { status: 500 });
  }
};
