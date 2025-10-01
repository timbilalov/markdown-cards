import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { validateCredentials } from '$lib/server/auth';
import { ADMIN_USERNAME } from '$lib/utils/envLoader';
import logger from '$lib/utils/logger';
import crypto from 'crypto';

// In-memory store for CSRF tokens (in production, use a database)
const csrfTokenStore = new Map<string, { token: string; expires: number }>();

// Generate a random CSRF token
function generateCSRFToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// Set auth cookie
function setAuthCookie(
  cookies: import('@sveltejs/kit').Cookies,
  username: string,
  rememberMe: boolean
) {
  // For "Remember Me", set expiration (30 days)
  // For session-only, don't set expiration (cookie expires when browser closes)
  const expires = rememberMe ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : undefined;

  // Set the authentication cookie
  cookies.set('auth_token', username, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    expires
  });

  // Set CSRF token cookie
  const csrfToken = generateCSRFToken();
  const csrfExpires = expires; // Same expiration as auth token

  cookies.set('csrf_token', csrfToken, {
    path: '/',
    httpOnly: false, // Need to access this from client for forms
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    expires: csrfExpires
  });

  // Store CSRF token in memory (in production, use a database)
  if (expires) {
    csrfTokenStore.set(username, {
      token: csrfToken,
      expires: expires.getTime()
    });
  }
}

export const POST: RequestHandler = async ({ request, cookies }) => {
  try {
    // Parse request body
    const { username, password, rememberMe } = await request.json();

    // Validate input
    if (!username || !password) {
      return json(
        { message: 'Username and password are required.' },
        { status: 400 }
      );
    }

    // Validate credentials
    const isValid = await validateCredentials(username, password);

    if (!isValid) {
      logger.info('Failed login attempt', {
        username,
        ip: request.headers.get('x-forwarded-for') || 'unknown'
      });

      // Return generic error message to prevent user enumeration
      return json(
        { message: 'Invalid username or password.' },
        { status: 401 }
      );
    }

    // Set authentication cookies
    setAuthCookie(cookies, username, rememberMe || false);

    logger.info('Successful login', {
      username,
      ip: request.headers.get('x-forwarded-for') || 'unknown'
    });

    // Return success response
    return json({
      message: 'Login successful',
      user: {
        username
      }
    });
  } catch (error) {
    logger.error('Login error', { error });
    return json(
      { message: 'An unexpected error occurred during login.' },
      { status: 500 }
    );
  }
};
