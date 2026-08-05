import admin from 'firebase-admin';
import firebaseAdmin from '../config/firebase';

function getBucket() {
  return (firebaseAdmin || admin.app()).storage().bucket();
}

// Mirrors the web backend's utils/firebaseStorage.js UPLOAD_PATHS so both
// backends organize files the same way in the shared bucket.
export const UPLOAD_PATHS = {
  MEMBER_POSTS: (membershipNo: string) => `members/${membershipNo}/posts`,
  MEMBER_PROFILE: (membershipNo: string) => `members/${membershipNo}/profile`,
  MEMBER_STORIES: (membershipNo: string) => `members/${membershipNo}/stories`,
  MEMBER_FAMILY_ALBUM: (membershipNo: string) => `members/${membershipNo}/family-albums`,
  MATRIMONY_CANDIDATE: (membershipNo: string) => `matrimony/candidates/${membershipNo}`,
  MATRIMONY_FORM: (membershipNo: string) => `matrimony/forms/${membershipNo}`,
  ANNOUNCEMENTS: () => `announcements`,
  LEADERS: () => `leaders`,
};

interface UploadInput {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

/**
 * Uploads a file to the shared private Firebase Storage bucket and returns
 * the same host-less proxy-path format the web backend writes
 * (`/api/v1/portal/media?path=<encoded>`), so posts/stories created via
 * either backend look identical in the DB and both know how to resolve them
 * back to a loadable URL via getSignedMediaUrl(). No image re-encoding here
 * (the web backend uses `sharp` to convert to webp; that's a native
 * dependency this backend doesn't carry yet — files are stored as-is).
 */
export async function uploadToFirebase(file: UploadInput, destinationPath: string): Promise<string> {
  const ext = file.originalname.includes('.') ? file.originalname.slice(file.originalname.lastIndexOf('.')) : '';
  const fileName = `${Date.now()}_${file.originalname.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const fullPath = `${destinationPath}/${fileName}${ext}`;

  const storageFile = getBucket().file(fullPath);
  await storageFile.save(file.buffer, {
    metadata: { contentType: file.mimetype },
    public: false,
  });

  return `/api/v1/portal/media?path=${encodeURIComponent(fullPath)}`;
}

// Every call to getSignedMediaUrl for the same file previously generated a
// brand new signature (a fresh `Date.now()`-based expiry baked into the
// URL), so the exact URL string changed on almost every request. Since
// expo-image (and HTTP caches generally) key their cache by URL, a
// constantly-changing URL for the same underlying photo meant the app
// re-downloaded every image from scratch on nearly every screen visit —
// the actual cause of "too much data usage" / growing on-device cache
// bloat, not the image sizes themselves (already addressed separately by
// compressing new uploads). Memoizing the signed URL per file path so
// repeat requests within its validity window get the byte-identical URL
// lets the client's own image cache actually work. Resets on server
// restart — acceptable since a fresh sign just costs one extra GCS call.
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();
// GCS V4 signed URLs cap out at 7 days; refresh a bit early so a URL is
// never handed out right at the edge of expiring mid-download.
const SIGNED_URL_TTL_MS = 6 * 24 * 60 * 60 * 1000;
const SIGNED_URL_REFRESH_MARGIN_MS = 30 * 60 * 1000;

/**
 * Resolves a private Firebase Storage path or proxy URL (as written by the
 * web backend's uploadToFirebase — `/api/v1/portal/media?path=<encoded>`)
 * into a signed HTTPS URL the client can actually load. Existing posts
 * created via the web app store this proxy-path format; the mobile backend
 * never resolved it, so their images/videos rendered blank.
 *
 * Absolute URLs (Google Drive proxy links from the mobile app's own upload
 * path, or anything already `http(s)://`) pass through unchanged.
 */
export async function getSignedMediaUrl(source: string | null | undefined): Promise<string | null> {
  if (!source || typeof source !== 'string') return (source as any) ?? null;

  // A raw base64 data URI (from a legacy/web-app upload bug that stored
  // the image inline instead of uploading it) is already directly
  // renderable — treating it as a Firebase file path below would generate
  // a bogus "signed" GCS URL hundreds of KB long instead of erroring, which
  // is how this bug first surfaced (see cleanup_broken_photos.sql).
  if (source.startsWith('data:')) return source;

  let filePath = source;

  if (source.includes('/media?path=')) {
    try {
      const urlObj = new URL(source, 'http://localhost');
      filePath = urlObj.searchParams.get('path') || source;
    } catch {
      const match = source.match(/path=([^&]+)/);
      if (match) filePath = decodeURIComponent(match[1]);
    }
  }

  if (!filePath || filePath.startsWith('http')) return source;

  const cached = signedUrlCache.get(filePath);
  if (cached && cached.expiresAt - SIGNED_URL_REFRESH_MARGIN_MS > Date.now()) {
    return cached.url;
  }

  try {
    const expiresAt = Date.now() + SIGNED_URL_TTL_MS;
    const storageFile = getBucket().file(filePath);
    const [url] = await storageFile.getSignedUrl({ action: 'read', expires: expiresAt });
    signedUrlCache.set(filePath, { url, expiresAt });
    return url;
  } catch (err: any) {
    console.warn(`[firebaseStorage] Failed to sign media URL for ${filePath}:`, err.message);
    return source;
  }
}

// Resolves every entry in an images array (mixed Drive URLs / Firebase proxy
// paths), concurrently.
export async function resolveMediaUrls(images: (string | null | undefined)[] | null | undefined): Promise<string[]> {
  if (!images || images.length === 0) return [];
  const resolved = await Promise.all(images.map((url) => getSignedMediaUrl(url)));
  return resolved.filter((u): u is string => !!u);
}
