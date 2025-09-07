import fs from 'fs/promises';
import path from 'path';
import { parseMarkdown } from '$lib/utils/markdownParser';
import { getMarkdownDir } from '$lib/utils/markdownPath';

export async function load() {
  try {
    // This code only runs on the server
    const markdownDir = getMarkdownDir();

    // Check if directory exists, create if it doesn't
    try {
      await fs.access(markdownDir);
    } catch (accessError) {
      // Directory doesn't exist, create it
      console.log('Markdown directory not found, creating it...');
      await fs.mkdir(markdownDir, { recursive: true });
    }

    const files = await fs.readdir(markdownDir);
    // Filter only markdown files
    const markdownFiles = files.filter(file => file.endsWith('.md'));

    // Read each file and extract the title
    const cards = await Promise.all(
      markdownFiles.map(async (fileName) => {
        const filePath = path.join(markdownDir, fileName);
        const content = await fs.readFile(filePath, 'utf8');
        const parsedCard = parseMarkdown(content);
        return {
          id: fileName,
          title: parsedCard.title
        };
      })
    );

    return { cards };
  } catch (error: any) {
    console.error('Error loading cards:', error);
    return { cards: [] };
  }
}
