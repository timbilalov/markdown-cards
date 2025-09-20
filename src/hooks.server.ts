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
  // Skip authentication for static files and API routes
  if (event.url.pathname.startsWith('/favicon.ico') || event.url.pathname.startsWith('/api/')) {
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

  // Check for authorization header
  const authHeader = event.request.headers.get('authorization');

  if (!authHeader) {
    logger.info('Unauthorized access attempt - missing auth header', {
      ip: clientIP,
      path: event.url.pathname
    });
    return new Response('Unauthorized', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Secure Area"'
      }
    });
  }

  // Parse Basic Auth credentials
  const encodedCredentials = authHeader.split(' ')[1];
  const decodedCredentials = atob(encodedCredentials);
  const [username, password] = decodedCredentials.split(':');

  // Validate credentials
  const isValid = await validateCredentials(username, password);

  if (!isValid) {
    logger.info('Failed login attempt', {
      username,
      ip: clientIP
    });
    return new Response('Unauthorized', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Secure Area"'
      }
    });
  }

  // Log successful authentication
  logger.info('Successful login', {
    username,
    ip: clientIP
  });

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
