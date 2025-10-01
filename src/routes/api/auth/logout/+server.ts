import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import logger from '$lib/utils/logger';

export const POST: RequestHandler = async ({ cookies, request }) => {
  try {
    // Get the username from the auth cookie before deleting it
    const username = cookies.get('auth_token');

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

    if (username) {
      logger.info('User logged out', {
        username,
        ip: request.headers.get('x-forwarded-for') || 'unknown'
      });
    }

    // Return success response
    return json({ message: 'Logout successful' });
  } catch (error) {
    logger.error('Logout error', { error });
    return json(
      { message: 'An unexpected error occurred during logout.' },
      { status: 500 }
    );
  }
};
