import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Keep unknown API routes as non-page responses under the hook's fallback CSP.
// Authentication, Origin checks and private-cache policy still run in the hooks.
export const fallback: RequestHandler = () => json({ error: 'Not found' }, { status: 404 });
