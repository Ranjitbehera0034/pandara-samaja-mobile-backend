import axios from 'axios';

// Restricted to Facebook only, and enforced here server-side (never trust
// the client's own facebook.ts regex alone) — this fetches a caller-
// supplied URL, so an unrestricted version would be an SSRF hole letting
// any authenticated member make the server request arbitrary internal or
// external URLs. Only facebook.com/fb.watch is ever fetched.
const ALLOWED_HOST_RE = /^(?:www\.|m\.)?(?:facebook\.com|fb\.watch)$/i;

export interface LinkPreview {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Regex-based, not a full HTML parser — same "simple extractor" philosophy
// as utils/facebook.ts and utils/youtube.ts. Handles both attribute orders
// (property-then-content and content-then-property), which is all Meta's
// own markup actually uses.
function extractMeta(html: string, property: string): string | null {
  const propFirst = new RegExp(`<meta[^>]+property=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i');
  const contentFirst = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${property}["']`, 'i');
  const match = html.match(propFirst) || html.match(contentFirst);
  return match ? decodeHtmlEntities(match[1]) : null;
}

// Simple in-memory cache — the same viral post URL gets shared/viewed by
// many members, and each preview costs a real outbound request to
// Facebook. Not persisted, not shared across instances; just enough to
// stop hammering Facebook when one post is being actively viewed.
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { value: LinkPreview | null; expiresAt: number }>();

// Facebook serves full Open Graph tags to known crawler user agents
// (confirmed live via curl) but a stripped, JS-only shell to normal
// browser user agents — this is the same trick WhatsApp/Telegram/iMessage
// link previews rely on.
const CRAWLER_USER_AGENT = 'facebookexternalhit/1.1';

export async function fetchFacebookLinkPreview(url: string): Promise<LinkPreview | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol) || !ALLOWED_HOST_RE.test(parsed.hostname)) {
    return null;
  }

  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let result: LinkPreview | null = null;
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': CRAWLER_USER_AGENT },
      timeout: 6000,
      maxRedirects: 5,
      maxContentLength: 2 * 1024 * 1024, // this is a meta-tag scrape, not a download
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const html = String(res.data);
    const title = extractMeta(html, 'og:title');
    const description = extractMeta(html, 'og:description');
    const image = extractMeta(html, 'og:image');
    const siteName = extractMeta(html, 'og:site_name') || 'Facebook';
    if (title || description || image) {
      result = { title, description, image, siteName };
    }
  } catch {
    result = null;
  }

  cache.set(url, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}
