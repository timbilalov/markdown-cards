import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { verifySession } from '$lib/server/session';
import logger from '$lib/utils/logger';

const headers = { 'Cache-Control': 'private, no-store' };

export const GET: RequestHandler = async ({ cookies }) => {
  try {
    const session = verifySession(cookies.get('auth_token'));

    if (!session) {
      return json({ error: 'Not authenticated' }, { status: 401, headers });
    }

    return json({ username: session.username }, { headers });
  } catch {
    logger.error('Error fetching user data');
    return json({ error: 'Internal server error' }, { status: 500, headers });
  }
};
