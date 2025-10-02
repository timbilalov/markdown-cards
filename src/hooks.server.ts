import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';
import { validateCredentials } from '$lib/server/auth';
import logger from '$lib/utils/logger';

// In-memory store for rate limiting
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

// Rate limiting configuration
const RATE_LIMIT = 100; // requests per hour
const TIME_WINDOW = 60 * 60 * 1000; // 1 hour in milliseconds

// Check rate limit for an IP
function checkRateLimit(ip: string): { allowed: boolean; resetTime?: number } {
  const now = Date.now();
  let record = rateLimitStore.get(ip);

  // Reset count if time window has passed
  if (record && record.resetTime <= now) {
    record = { count: 0, resetTime: now + TIME_WINDOW };
    rateLimitStore.set(ip, record);
  } else if (!record) {
    record = { count: 0, resetTime: now + TIME_WINDOW };
    rateLimitStore.set(ip, record);
  }

  // Check if rate limit has been exceeded
  if (record.count >= RATE_LIMIT) {
    return { allowed: false, resetTime: record.resetTime };
  }

  // Increment request count
  record.count++;
  rateLimitStore.set(ip, record);

  return { allowed: true };
}

// Cleanup function to remove expired rate limit records
function cleanupRateLimitStore() {
  const now = Date.now();
  for (const [ip, record] of rateLimitStore.entries()) {
    if (record.resetTime <= now) {
      rateLimitStore.delete(ip);
    }
  }
}

// Run cleanup every hour
setInterval(cleanupRateLimitStore, 60 * 60 * 1000);

// Authentication middleware
const authMiddleware: Handle = async ({ event, resolve }) => {
  // Skip authentication for static files, API auth routes, and login page
  if (
    event.url.pathname.startsWith('/favicon.ico') ||
    event.url.pathname.startsWith('/api/auth/login') ||
    event.url.pathname.startsWith('/api/auth/logout') ||
    event.url.pathname.startsWith('/api/auth/user') ||
    event.url.pathname.startsWith('/api/auth/status') ||
    event.url.pathname === '/login'
  ) {
    return resolve(event);
  }

  // Check rate limit
  const clientIP = event.getClientAddress();
  const rateLimitResult = checkRateLimit(clientIP);
  if (!rateLimitResult.allowed) {
    logger.warn('Rate limit exceeded', {
      ip: clientIP,
      count: RATE_LIMIT,
      limit: RATE_LIMIT
    });
    return new Response('Too Many Requests', {
      status: 429,
      headers: {
        'Retry-After': Math.ceil(((rateLimitResult.resetTime || 0) - Date.now()) / 1000).toString()
      }
    });
  }

  // Check for auth token cookie
  const authToken = event.cookies.get('auth_token');

  if (!authToken) {
    // Redirect to login page
    return new Response(null, {
      status: 302,
      headers: {
        'Location': '/login'
      }
    });
  }

  // For form submissions, check CSRF token
  // Skip CSRF check for API endpoints that are already protected by authentication
  if ((event.request.method === 'POST' || event.request.method === 'PUT' || event.request.method === 'DELETE') &&
      !event.url.pathname.startsWith('/api/cloud/upload')) {
    const csrfToken = event.cookies.get('csrf_token');
    const requestCSRF = event.request.headers.get('X-CSRF-Token') ||
                       (event.request.headers.get('content-type')?.includes('form') ?
                        new URLSearchParams(await event.request.text()).get('_csrf') : null);

    if (!csrfToken || csrfToken !== requestCSRF) {
      logger.warn('CSRF token mismatch', {
        ip: clientIP,
        userAgent: event.request.headers.get('user-agent')
      });
      return new Response('Forbidden', { status: 403 });
    }
  }

  // Log successful authentication
  logger.info('Authenticated request', {
    username: authToken,
    ip: clientIP,
    path: event.url.pathname
  });

  // Get current cookie options to determine if it's a persistent cookie
  // In a real implementation, you would check the actual cookie expiration
  // For now, we'll extend the session with the same logic as login
  // If it's a persistent cookie (Remember Me), extend it for 30 days
  // If it's a session cookie, don't set expiration (expires when browser closes)

  // For simplicity in this implementation, we'll extend persistent cookies
  // and leave session cookies as they are
  const cookieHeader = event.request.headers.get('cookie');
  if (cookieHeader && cookieHeader.includes('auth_token=')) {
    // Check if the cookie appears to be persistent by looking for an expiration
    // This is a simplified check - in a real implementation, you would parse the cookie properly
    const isPersistent = cookieHeader.includes('Expires=') || cookieHeader.includes('expires=');

    if (isPersistent) {
      // Extend the persistent cookie for another 30 days
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      event.cookies.set('auth_token', authToken, {
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        expires
      });

      // Also update the CSRF token cookie expiration
      const csrfToken = event.cookies.get('csrf_token');
      if (csrfToken) {
        event.cookies.set('csrf_token', csrfToken, {
          path: '/',
          httpOnly: false,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict',
          expires
        });
      }
    }
    // For session cookies, we don't need to update anything
  }

  return resolve(event);
};

// HTTPS enforcement middleware
const httpsMiddleware: Handle = ({ event, resolve }) => {
  const protocol = event.url.protocol;

  // If we're in production and not using HTTPS, redirect
  if (process.env.NODE_ENV === 'production' && protocol !== 'https:') {
    const httpsUrl = `https://${event.url.host}${event.url.pathname}${event.url.search}`;
    return new Response(null, {
      status: 301,
      headers: {
        'Location': httpsUrl
      }
    });
  }

  return resolve(event);
};

// Security headers middleware
const securityHeadersMiddleware: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);

  // Add security headers
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  return response;
};

// Export the middleware sequence
export const handle = sequence(
  httpsMiddleware,
  authMiddleware,
  securityHeadersMiddleware
);
