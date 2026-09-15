// scraper/src/youtube.ts
// Minimal YouTube Data API v3 client — just enough to list a channel's
// recent uploads. Uses playlistItems.list against the channel's "uploads"
// playlist rather than search.list: search.list costs 100 quota units per
// call against a 10,000/day free-tier budget, while playlistItems.list
// costs 1 — checking ~13 channels daily on search.list would burn most of
// the day's quota on this alone.
//
// Every real YouTube channel has an uploads playlist whose ID is
// derivable from the channel ID by swapping the "UC" prefix for "UU" —
// a stable, documented convention, not a guess specific to this project.
import axios from 'axios';

export interface YoutubeVideo {
  videoId: string;
  title: string;
  publishedAt: string;
}

const API_BASE = 'https://www.googleapis.com/youtube/v3';

function uploadsPlaylistId(channelId: string): string {
  if (!channelId.startsWith('UC')) {
    throw new Error(`Expected a channel ID starting with "UC", got: ${channelId}`);
  }
  return `UU${channelId.slice(2)}`;
}

export async function fetchLatestUploads(
  channelId: string,
  apiKey: string,
  maxResults = 5
): Promise<YoutubeVideo[]> {
  const playlistId = uploadsPlaylistId(channelId);
  const res = await axios.get(`${API_BASE}/playlistItems`, {
    params: {
      part: 'snippet,contentDetails',
      playlistId,
      maxResults,
      key: apiKey,
    },
    timeout: 15000,
  });

  const items = res.data?.items || [];
  return items
    .map((item: any) => ({
      videoId: item.contentDetails?.videoId,
      title: item.snippet?.title,
      publishedAt: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt,
    }))
    .filter((v: YoutubeVideo) => v.videoId && v.title);
}
