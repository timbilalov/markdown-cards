import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the correct markdown directory path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// For the script, we always use the root static directory
const markdownDir = path.join(__dirname, '../static/markdown');
console.log('markdownDir', markdownDir, path.resolve(markdownDir));

if (fs.existsSync(markdownDir)) {
  const files = fs.readdirSync(markdownDir);
  console.log('static/markdown directory exists', files);
  process.exit(0);
}

// Create the directory if it doesn't exist
try {
  fs.mkdirSync(markdownDir, { recursive: true });
  console.log('static/markdown directory ensured');

  // Create a sample markdown file to ensure the directory is not empty
  const sampleFile = path.join(markdownDir, 'sample-card.md');
  const sampleContent = `# Sample Card

## Meta
### id
sample-card

### created
${new Date().toISOString()}

### modified
${new Date().toISOString()}

## Data
This is a sample card to ensure the markdown directory is not empty during deployment.

### Section 1
- Item 1
- Item 2
- Item 3
`;

  fs.writeFileSync(sampleFile, sampleContent);
  console.log('Sample card created', sampleFile);
} catch (err) {
  console.error('Error ensuring static/markdown directory:', err);
  process.exit(1);
}

