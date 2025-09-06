# Security Implementation

This document describes the security features implemented in the Markdown Cards application.

## Authentication System

The application implements HTTP Basic Authentication with the following features:

### Credentials
- Username: `admin`
- Password: `********` (stored as bcrypt hash in environment variables)

### Implementation Details
- Uses bcryptjs for password hashing with 12 salt rounds
- Custom environment variable loader to avoid issues with SvelteKit's built-in env handling
- Credentials are validated in `src/lib/server/auth.ts`

## Authorization

All routes require authentication except for:
- Static assets (favicon, etc.)

## Rate Limiting

- 100 requests per hour per IP address
- Implemented with an in-memory store
- Automatic cleanup of expired records

## HTTPS Enforcement

- Automatically redirects HTTP to HTTPS in production environments
- Controlled by the `NODE_ENV` environment variable

## Security Headers

The application sets the following security headers:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`

## Logging

- Comprehensive logging of authentication attempts
- Logs successful and failed login attempts
- Logs rate limiting events
- Uses a custom logger utility in `src/lib/utils/logger.ts`

## Environment Variables

The application requires the following environment variables:
- `ADMIN_USERNAME` - The admin username
- `ADMIN_PASSWORD_HASH` - The bcrypt hash of the admin password

To generate a new password hash, run:
```bash
npm run generate-password
```

## Deployment

The application is configured for deployment to Vercel with:
- Security headers in `vercel.json`
- Environment variables configured in Vercel dashboard
