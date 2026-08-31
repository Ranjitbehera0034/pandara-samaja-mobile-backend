// src/utils/ogScrape.ts
// Shared Open Graph meta-tag extraction, used by both linkPreview.ts
// (Facebook) and youtubePreview.ts (YouTube channel links) — same
// regex-based "simple extractor" philosophy as utils/facebook.ts and
// utils/youtube.ts, not a full HTML parser.

export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Handles both attribute orders (property-then-content and
// content-then-property), which is all real-world markup actually uses.
export function extractMeta(html: string, property: string): string | null {
  const propFirst = new RegExp(`<meta[^>]+property=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i');
  const contentFirst = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${property}["']`, 'i');
  const match = html.match(propFirst) || html.match(contentFirst);
  return match ? decodeHtmlEntities(match[1]) : null;
}
