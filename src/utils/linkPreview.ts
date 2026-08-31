import axios from 'axios';
import { extractMeta } from './ogScrape';

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

export type FacebookContent =
  | { type: 'video'; embedHtml: string; image: string | null }
  | { type: 'link'; preview: LinkPreview };

// facebook.com/share/... (and /share/r/...) links are wrapper redirects —
// requesting an embed for the wrapper itself is what was silently broken:
// oembed_post rejects the wrapper shape outright, and oembed_video
// "succeeds" against it but Facebook then refuses to actually play the
// video (confirmed live — its own "video not available" error renders in
// place of the player). Resolving to the canonical post/reel URL first and
// requesting the embed against THAT is what actually plays (confirmed live
// in a browser: same reel, canonical URL, real thumbnail + working play
// button). This regex checks the RESOLVED url, not the original share
// link, to decide whether it's unambiguously a video.
const VIDEO_PATH_RE = /\/(reel|reels|videos)\//i;

// Simple in-memory cache — the same viral post URL gets shared/viewed by
// many members, and each preview costs a real outbound request to
// Facebook. Not persisted, not shared across instances; just enough to
// stop hammering Facebook when one post is being actively viewed.
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { value: FacebookContent | null; expiresAt: number }>();

// Facebook serves full Open Graph tags to known crawler user agents
// (confirmed live via curl) but a stripped, JS-only shell to normal
// browser user agents — this is the same trick WhatsApp/Telegram/iMessage
// link previews rely on.
const CRAWLER_USER_AGENT = 'facebookexternalhit/1.1';

async function fetchOembedVideoHtml(resolvedUrl: string): Promise<string | null> {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v21.0/oembed_video?url=${encodeURIComponent(resolvedUrl)}`,
      { timeout: 6000 }
    );
    return (res.data && res.data.html) || null;
  } catch {
    return null;
  }
}

export async function resolveFacebookContent(url: string): Promise<FacebookContent | null> {
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

  let result: FacebookContent | null = null;
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

    // axios/follow-redirects exposes the final URL after following the
    // share-link redirect chain — strip its tracking query string
    // (?rdid=...&share_url=...) down to the bare canonical path.
    const rawResolvedUrl = (res.request as any)?.res?.responseUrl || url;
    let resolvedUrl = rawResolvedUrl;
    try {
      const u = new URL(rawResolvedUrl);
      resolvedUrl = `${u.origin}${u.pathname}`;
    } catch {
      // keep rawResolvedUrl as-is
    }

    if (VIDEO_PATH_RE.test(resolvedUrl)) {
      const embedHtml = await fetchOembedVideoHtml(resolvedUrl);
      if (embedHtml) {
        result = { type: 'video', embedHtml, image };
      }
    }

    if (!result && (title || description || image)) {
      result = { type: 'link', preview: { title, description, image, siteName } };
    }
  } catch {
    result = null;
  }

  cache.set(url, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}
