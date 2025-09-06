import fs from 'fs/promises';
import path from 'path';
import { parseMarkdown } from '$lib/utils/markdownParser';

export async function load() {
  try {
    // This code only runs on the server
    const markdownDir = path.resolve('static/markdown');
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
