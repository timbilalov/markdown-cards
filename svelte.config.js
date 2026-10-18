import { createDeploymentAdapter } from './config/deploymentAdapters.js';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
		adapter: createDeploymentAdapter(),
		// SvelteKit authorizes its own inline bootstrap with a per-response nonce.
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				'script-src': ['self'],
				'style-src': ['self'],
				'script-src-attr': ['none'],
				// Kit's generated #svelte-announcer uses one fixed visually-hidden
				// style. Authorize that exact attribute, not arbitrary inline CSS.
				// Browser E2E verifies this hash when Kit's generated markup changes.
				'style-src-attr': process.env.NODE_ENV === 'development' ? ['unsafe-inline']
					: ['unsafe-hashes', 'sha256-S8qMpvofolR8Mpjy4kQvEm7m1q8clzU4dfDH0AmvZjo='],
				'connect-src': ['self'],
				'font-src': ['self'],
				'img-src': ['self', 'data:', 'http:', 'https:'],
				'base-uri': ['none'],
				'object-src': ['none'],
				'frame-src': ['none'],
				'frame-ancestors': ['none'],
				'form-action': ['self']
			}
		},
		// The strict Origin middleware in src/hooks.server.ts owns CSRF checks.
		// Let forms reach it for the same auth/CSRF response contract as JSON.
		// Keep that middleware: it still rejects missing or nonmatching origins.
		csrf: {
			trustedOrigins: ['*']
		},
	}
};

export default config;
