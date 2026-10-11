import { sequence } from '@sveltejs/kit/hooks';
import { json } from '@sveltejs/kit';
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { verifySession } from '$lib/server/session';
import logger from '$lib/utils/logger';

// In-memory store for rate limiting
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

// Rate limiting configuration
const RATE_LIMIT = 100; // requests per hour
const TIME_WINDOW = 60 * 60 * 1000; // 1 hour in milliseconds
let nextCleanup = 0;

// Check rate limit for an IP
function checkRateLimit(ip: string): { allowed: boolean; resetTime?: number } {
  const now = Date.now();
  if (now >= nextCleanup) { cleanupRateLimitStore(); nextCleanup = now + TIME_WINDOW; }
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

// Authentication middleware
const publicPaths = new Set([
  '/favicon.ico', '/api/auth/login', '/api/auth/logout',
  '/api/auth/user', '/api/auth/status', '/login'
]);

const authMiddleware: Handle = async ({ event, resolve }) => {
  const session = verifySession(event.cookies.get('auth_token'));
  const isPublic = publicPaths.has(event.url.pathname);

  // Check rate limit
  const clientIP = event.getClientAddress();
  // Protect login and unauthenticated probing. Normal authenticated cloud
  // reads/writes must not exhaust the login budget while refreshing a folder.
  const rateLimitResult = event.url.pathname === '/api/auth/login' || (!isPublic && !session)
    ? checkRateLimit(clientIP) : { allowed: true };
  if (!rateLimitResult.allowed) {
    logger.warn('Rate limit exceeded', {
      ip: clientIP,
      count: RATE_LIMIT,
      limit: RATE_LIMIT
    });
    const options = { status: 429, headers: {
        'Retry-After': Math.ceil(((rateLimitResult.resetTime || 0) - Date.now()) / 1000).toString()
      } };
    return event.url.pathname.startsWith('/api/')
      ? json({ message: 'Too Many Requests', error: 'RATE_LIMITED', outcome: 'not-written' }, options)
      : new Response('Too Many Requests', options);
  }

  // Auth handlers verify identity themselves; logout also clears stale cookies.
  if (isPublic) return resolve(event);

  // Authenticate before invoking handlers or reading a state-changing body.
  if (!session) {
    if (event.url.pathname.startsWith('/api/')) {
      return json({ error: 'Not authenticated' }, {
        status: 401,
        headers: { 'Cache-Control': 'private, no-store' }
      });
    }
    return new Response(null, {
      status: 302,
      headers: {
        'Location': '/login',
        'Cache-Control': 'private, no-store'
      }
    });
  }

  // Log successful authentication
  logger.info('Authenticated request', {
    username: session.username,
    ip: clientIP,
    path: event.url.pathname
  });

  return resolve(event);
};

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

// Runs after authentication, including on auth-public paths such as login/logout.
// Compare the browser Origin to the framework URL without consuming the body.
const csrfMiddleware: Handle = ({ event, resolve }) => {
  if (!safeMethods.has(event.request.method)
    && event.request.headers.get('origin') !== event.url.origin) {
    logger.warn('CSRF origin denied');
    const options = { status: 403, headers: { 'Cache-Control': 'private, no-store' } };
    if (event.url.pathname.startsWith('/api/')) {
      return json({ error: 'Forbidden', code: 'CSRF_ORIGIN_DENIED' }, options);
    }
    return new Response('Forbidden', options);
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
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.headers.delete('X-XSS-Protection');
  if (event.url.protocol === 'https:') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  } else {
    response.headers.delete('Strict-Transport-Security');
  }
  // Rendered HTML already has SvelteKit's CSP, including its bootstrap nonce.
  // Early refusals, redirects and endpoint responses need a restrictive fallback.
  if (!response.headers.has('Content-Security-Policy')) {
    response.headers.set('Content-Security-Policy',
      "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
  }

  return response;
};

function checkIsPrivateRequest(event: RequestEvent): boolean {
  // Matched application routes are dynamic. Include errors beneath private URL
  // prefixes even when no route matched; never infer an asset from its extension.
  return event.route.id !== null || ['/api', '/card', '/markdown'].some(prefix =>
    event.url.pathname === prefix || event.url.pathname.startsWith(`${prefix}/`));
}

const privateCacheMiddleware: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  if (!checkIsPrivateRequest(event)) return response;

  response.headers.set('Cache-Control', 'private, no-store');
  // Do not leave a higher-priority cache directive or a validator that lets
  // SvelteKit turn protected HTML into a 304 after the hooks have returned.
  for (const header of ['CDN-Cache-Control', 'Vercel-CDN-Cache-Control',
    'Surrogate-Control', 'Expires', 'ETag', 'Last-Modified']) {
    response.headers.delete(header);
  }
  return response;
};

// Cache and security policies wrap early refusals as well as resolved routes.
export const handle = sequence(
  privateCacheMiddleware,
  securityHeadersMiddleware,
  httpsMiddleware,
  authMiddleware,
  csrfMiddleware
);
