import admin from 'firebase-admin';
import firebaseAdmin from '../config/firebase';

function getBucket() {
  return (firebaseAdmin || admin.app()).storage().bucket();
}

// Mirrors the web backend's utils/firebaseStorage.js UPLOAD_PATHS so both
// backends organize files the same way in the shared bucket.
export const UPLOAD_PATHS = {
  MEMBER_POSTS: (membershipNo: string) => `members/${membershipNo}/posts`,
  MEMBER_STORIES: (membershipNo: string) => `members/${membershipNo}/stories`,
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

/**
 * Resolves a private Firebase Storage path or proxy URL (as written by the
 * web backend's uploadToFirebase — `/api/v1/portal/media?path=<encoded>`)
 * into a temporary signed HTTPS URL the client can actually load. Existing
 * posts created via the web app store this proxy-path format; the mobile
 * backend never resolved it, so their images/videos rendered blank.
 *
 * Absolute URLs (Google Drive proxy links from the mobile app's own upload
 * path, or anything already `http(s)://`) pass through unchanged.
 */
export async function getSignedMediaUrl(source: string | null | undefined, expiresMinutes = 60): Promise<string | null> {
  if (!source || typeof source !== 'string') return (source as any) ?? null;

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

  try {
    const storageFile = getBucket().file(filePath);
    const [url] = await storageFile.getSignedUrl({
      action: 'read',
      expires: Date.now() + 1000 * 60 * expiresMinutes,
    });
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
