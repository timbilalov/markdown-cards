import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import logger from '$lib/utils/logger';

export const GET: RequestHandler = async ({ cookies }) => {
  try {
    // Get the auth token from cookies
    const authToken = cookies.get('auth_token');

    if (!authToken) {
      return json({ error: 'Not authenticated' }, { status: 401 });
    }

    // In this implementation, the auth token is the username
    // In a more complex system, you might decode a JWT or look up user data
    const user = {
      username: authToken,
      // You could add more user data here if needed
    };

    return json(user);
  } catch (error) {
    logger.error('Error fetching user data', { error });
    return json({ error: 'Internal server error' }, { status: 500 });
  }
};
