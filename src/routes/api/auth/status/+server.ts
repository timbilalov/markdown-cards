import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { verifySession } from '$lib/server/session';

export const GET: RequestHandler = async ({ cookies }) => {
  const session = verifySession(cookies.get('auth_token'));

  return json({
    authenticated: session !== null,
    username: session?.username ?? null
  }, { headers: { 'Cache-Control': 'private, no-store' } });
};
