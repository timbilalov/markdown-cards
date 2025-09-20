import type { PageLoad } from './$types';
import { error } from '@sveltejs/kit';

export const load: PageLoad = async ({ params }) => {
  const { slug } = params;

  if (!slug) {
    throw error(404, 'Card not found');
  }

  // For server-side rendering, we'll return the slug
  // The client will load the actual card data
  return {
    slug
  };
};
