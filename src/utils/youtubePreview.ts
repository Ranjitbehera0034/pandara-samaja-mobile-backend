import axios from 'axios';
import { extractMeta } from './ogScrape';

// Restricted to youtube.com only, and enforced here server-side (never
// trust the client's own regex alone) — this fetches a caller-supplied
// URL, so an unrestricted version would be an SSRF hole. Only used for
// channel links (youtube.com/@handle, /channel/UC..., /c/..., /user/...) —
// actual video URLs are handled separately via YouTubeEmbed's iframe embed,
// which needs no server-side fetch.
const ALLOWED_HOST_RE = /^(?:www\.|m\.)?youtube\.com$/i;

export interface YouTubeChannelPreview {
  title: string | null;
  image: string | null;
}

// Simple in-memory cache — same rationale as linkPreview.ts's: the same
// channel link can be shared/viewed by many members, no need to refetch
// YouTube every time.
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { value: YouTubeChannelPreview | null; expiresAt: number }>();

// Unlike Facebook, YouTube serves full Open Graph tags to an ordinary
// browser user agent — confirmed live via curl, no crawler-UA trick
// needed.
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

export async function fetchYouTubeChannelPreview(url: string): Promise<YouTubeChannelPreview | null> {
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

  let result: YouTubeChannelPreview | null = null;
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': BROWSER_USER_AGENT },
      timeout: 6000,
      maxRedirects: 5,
      maxContentLength: 2 * 1024 * 1024, // this is a meta-tag scrape, not a download
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const html = String(res.data);
    const title = extractMeta(html, 'og:title');
    const image = extractMeta(html, 'og:image');
    if (title || image) {
      result = { title, image };
    }
  } catch {
    result = null;
  }

  cache.set(url, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}
