import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { validateCredentials } from '$lib/server/auth';
import { issueSession, type IssuedSession } from '$lib/server/session';
import { readRequestBody } from '$lib/server/requestBody';
import { parseLoginRequest } from '$lib/server/loginRequest';
import logger from '$lib/utils/logger';

const headers = { 'Cache-Control': 'private, no-store' };
const bodyErrors = {
  'unsupported-media-type': { status: 415, message: 'Unsupported request media type.' },
  'too-large': { status: 413, message: 'Request body is too large.' },
  invalid: { status: 400, message: 'Invalid login request.' }
};

function setAuthCookie(
  cookies: import('@sveltejs/kit').Cookies,
  issued: IssuedSession
) {
  // Browser persistence never extends the absolute expiry in the signed claims.
  const expires = issued.session.rememberMe ? new Date(issued.session.expiresAt) : undefined;

  cookies.set('auth_token', issued.token, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    expires
  });

  // Retire cookies issued by the old double-submit mechanism.
  cookies.delete('csrf_token', {
    path: '/',
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  });
}

export const POST: RequestHandler = async ({ request, cookies }) => {
  try {
    const bodyResult = await readRequestBody(request, 'json');
    if (bodyResult.status !== 'success') {
      const { status, message } = bodyErrors[bodyResult.status];
      return json({ message }, { status, headers });
    }
    const input = await parseLoginRequest(bodyResult.response);
    if (input === null) {
      return json({ message: 'Invalid login request.' }, { status: 400, headers });
    }
    const { username, password, rememberMe = false } = input;

    // Validate input
    if (!username || !password) {
      return json(
        { message: 'Username and password are required.' },
        { status: 400, headers }
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
        { status: 401, headers }
      );
    }

    let issued: IssuedSession;
    try {
      issued = issueSession(username, rememberMe);
    } catch {
      logger.error('Authentication is not configured');
      return json({ message: 'Authentication is not configured.' }, { status: 503, headers });
    }
    setAuthCookie(cookies, issued);

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
    }, { headers });
  } catch {
    // Do not serialize errors that could contain credentials or cookie values.
    logger.error('Login error');
    return json(
      { message: 'An unexpected error occurred during login.' },
      { status: 500, headers }
    );
  }
};
