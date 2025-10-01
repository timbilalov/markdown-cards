import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';

export const GET: RequestHandler = async ({ cookies }) => {
  // Check if auth token cookie exists
  const authToken = cookies.get('auth_token');

  // Return authentication status
  return json({
    authenticated: !!authToken,
    username: authToken || null
  });
};
