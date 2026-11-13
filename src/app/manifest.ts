import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Folio · Book Release Tracker',
    short_name: 'Folio',
    description:
      'Track upcoming book releases sorted by week, followed authors, To-Do reading list, and yearly reading challenges.',
    start_url: '/',
    display: 'standalone',
    background_color: '#F7F2E9',
    theme_color: '#F7F2E9',
    orientation: 'portrait-primary',
    icons: [
      {
        src: '/icon',
        sizes: '512x512',
        type: 'image/png',
      },
      {
        src: '/apple-icon',
        sizes: '180x180',
        type: 'image/png',
      },
    ],
  };
}
