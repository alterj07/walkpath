import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// The canonical site URL. The deploy workflow sets SITE_URL; locally the
// *.pages.dev placeholder keeps absolute links (feeds, sitemap) well-formed.
const site = globalThis.process?.env?.SITE_URL || 'https://walkpath.pages.dev';

export default defineConfig({
  site,
  output: 'static',
  integrations: [react()],
  build: { inlineStylesheets: 'never' },
});
