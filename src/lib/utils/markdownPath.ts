import path from 'path';
import fs from 'fs';

/**
 * Get the correct path to the markdown directory based on the environment
 * In development, it's in the src/lib/data directory
 * In production/build, it might be in a different location
 */
export function getMarkdownDir(): string {
  // Check if we're in a browser environment
  if (typeof window !== 'undefined') {
    // In browser, we should use the API routes
    throw new Error('This function should only be called on the server');
  }

  // Define possible paths for the markdown directory
  const possiblePaths = [
    // Development path - new location
    path.resolve('src/lib/data/markdown'),

    // Previous development path - for backward compatibility
    path.resolve('static/markdown'),

    // Common production paths
    path.resolve('.svelte-kit/output/client/src/lib/data/markdown'),
    path.resolve('.svelte-kit/output/client/markdown'),
    path.resolve('.svelte-kit/output/static/markdown'),
    path.resolve('build/src/lib/data/markdown'),
    path.resolve('dist/src/lib/data/markdown'),

    // Vercel specific paths
    path.resolve('.vercel/output/static/markdown'),
  ];

  // Check each path to see if it exists
  for (const possiblePath of possiblePaths) {
    try {
        console.log('possiblePath', possiblePath);
        if (fs.existsSync(possiblePath)) {
            return possiblePath;
        }
    } catch (e) {
        // Continue to next path if this one fails
    }
  }

  // If none of the paths exist, log a warning and return the default path
  console.warn('Could not find markdown directory in any expected location, using default path');
  return path.resolve('src/lib/data/markdown');
}
