import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { verifySession } from '$lib/server/session';
import logger from '$lib/utils/logger';

const headers = { 'Cache-Control': 'private, no-store' };

export const POST: RequestHandler = async ({ cookies, request }) => {
  try {
    const session = verifySession(cookies.get('auth_token'));

    // Delete auth cookie with the same options used when setting it
    cookies.delete('auth_token', {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });

    // Delete CSRF token cookie with the same options used when setting it
    cookies.delete('csrf_token', {
      path: '/',
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });

    if (session) {
      logger.info('User logged out', {
        username: session.username,
        ip: request.headers.get('x-forwarded-for') || 'unknown'
      });
    }

    // Return success response
    return json({ message: 'Logout successful' }, { headers });
  } catch {
    logger.error('Logout error');
    return json(
      { message: 'An unexpected error occurred during logout.' },
      { status: 500, headers }
    );
  }
};
