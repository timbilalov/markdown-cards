import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import * as path from 'path';

console.log(`path.resolve(__dirname, 'static/markdown')`, path.resolve(__dirname, 'static/markdown'));

export default defineConfig({
	plugins: [sveltekit()],
	resolve: {
		alias: {
			$lib: path.resolve('./src/lib')
		}
	},
	server: {
		fs: {
			allow: [path.resolve(__dirname, 'static/markdown')]
		}
	}
});
