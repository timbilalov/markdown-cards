import { cloudService } from '$lib/services/cloudService';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
  try {
    // Check if cloud service is authenticated (has access token)
    if (!cloudService.isAuthenticated()) {
      return new Response('Cloud service not configured', { status: 500 });
    }

    // Fetch list of files from Yandex Disk
    const files = await cloudService.listFiles();

    return json(files);
  } catch (error: any) {
    console.error('Error fetching files:', error);
    return new Response(`Error fetching files: ${error.message}`, { status: 500 });
  }
};
