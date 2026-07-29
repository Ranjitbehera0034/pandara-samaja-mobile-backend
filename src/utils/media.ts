// src/utils/media.ts
//
// portal_posts stores all media (images AND videos) in one `images text[]`
// column — there's no separate video flag in the DB. When we derive a
// "media" array from raw image URLs for API responses, we must infer the
// type from the URL's file extension instead of hardcoding `type: 'image'`
// for everything — otherwise real video URLs render through an <Image>
// component on the client instead of <Video> (blank/broken playback).
//
// Firebase signed URLs preserve the original file extension in the path
// portion before the `?` query string (e.g. `.../file.mp4?X-Goog-Signature=...`),
// and Google Drive/legacy URLs without a recognizable extension safely
// default to 'image' (previous behavior, no regression).

const VIDEO_EXTENSIONS = /\.(mp4|mov|webm|m4v|3gp|avi)(\?|$)/i;

export function inferMediaType(url: string): 'image' | 'video' {
  return VIDEO_EXTENSIONS.test(url) ? 'video' : 'image';
}

export function urlsToMedia(
  urls: (string | null | undefined)[] | null | undefined
): { url: string; type: 'image' | 'video' }[] {
  return (urls || [])
    .filter((u): u is string => !!u)
    .map(url => ({ url, type: inferMediaType(url) }));
}
