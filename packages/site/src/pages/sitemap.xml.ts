/**
 * Static sitemap: the home page, the category directory, every category page
 * that is not thin, and the static pages. Job pages are noindex and excluded.
 */
import type { APIRoute } from 'astro';
import { loadBuildData, rowsForPage, shouldNoindex } from '../lib/seo.ts';

const XML_ESCAPES: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => XML_ESCAPES[c] ?? c);
}

export const GET: APIRoute = ({ site }) => {
  const base = (site?.toString() ?? 'https://walkpath.pages.dev').replace(/\/+$/, '');
  const { pages, rows, generatedAt } = loadBuildData();
  const lastmod = generatedAt || new Date().toISOString();
  const paths = ['/', '/internships', '/alerts', '/about', '/status'];
  for (const entry of pages) {
    if (!shouldNoindex(rowsForPage(rows, entry))) paths.push(`/internships/${entry.slug}`);
  }
  const urls = paths
    .map((p) => `  <url><loc>${escapeXml(base + p)}</loc><lastmod>${escapeXml(lastmod)}</lastmod></url>`)
    .join('\n');
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
