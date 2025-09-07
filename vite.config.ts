import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import * as path from 'path';

const markdownDir = path.resolve(__dirname, 'src/lib/data/markdown');
console.log(`path.resolve(__dirname, 'src/lib/data/markdown')`, path.resolve(__dirname, 'src/lib/data/markdown'), 'markdownDir', markdownDir);

export default defineConfig({
	plugins: [sveltekit()],
	resolve: {
		alias: {
			$lib: path.resolve('./src/lib')
		}
	},
	server: {
		fs: {
			allow: ['**/data/markdown']
		}
	}
});
