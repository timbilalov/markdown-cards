import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import * as path from 'path';

const markdownDir = path.resolve('static/markdown');
console.log(`path.resolve(__dirname, 'static/markdown')`, path.resolve(__dirname, 'static/markdown'), 'markdownDir', markdownDir);

export default defineConfig({
	plugins: [sveltekit()],
	resolve: {
		alias: {
			$lib: path.resolve('./src/lib')
		}
	},
	server: {
		fs: {
			allow: ['**/static/markdown']
		}
	}
});
