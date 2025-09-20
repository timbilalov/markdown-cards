import { cloudService } from '$lib/services/cloudService';
import { parseMarkdown } from '$lib/utils/markdownParser';

export async function load({ fetch }) {
  try {
    // For server-side rendering, we'll return an empty array
    // The client will fetch the actual data
    return { cards: [] };
  } catch (error: any) {
    console.error('Error loading cards:', error);
    return { cards: [] };
  }
}
