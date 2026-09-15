// scraper/src/sources/youtubeChannels.ts
// Fixed registry of trusted, well-established free-education YouTube
// channels — the daily course scraper (courseIndex.ts) checks each one's
// uploads playlist for new videos and submits them into the
// course_lesson_submissions review queue (never auto-published — see
// that table's migration comment for why).
//
// Each channelId was resolved once by hand (grepping a channel page's
// "channelId" meta value) and hardcoded here rather than resolved by
// handle at runtime — one fewer API call per channel per run, and a
// channel's canonical ID never changes even if its handle/vanity URL
// does. `category` must exactly match a key in the mobile app's
// src/data/courseCategories.ts (COURSE_CATEGORIES) — it's what the
// admin review screen suggests attaching new lessons to.
export interface YoutubeChannel {
  channelId: string;
  channelName: string;
  category: string;
}

export const YOUTUBE_CHANNELS: YoutubeChannel[] = [
  { channelId: 'UCuWuAvEnKWez5BUr29VpwqA', channelName: 'wifistudy by Unacademy', category: 'Banking & Finance Exam Prep' },
  { channelId: 'UCuWuAvEnKWez5BUr29VpwqA', channelName: 'wifistudy by Unacademy', category: 'Railway Exam Prep' },
  { channelId: 'UC5H9MzrMkJ5iuN11vV2PLhA', channelName: 'Rojgar with Ankit Defence', category: 'Police & Defence Exam Prep' },
  { channelId: 'UCD16eo98AXl-9T61Xd711kQ', channelName: 'Physics Wallah — Alakh Pandey', category: 'Medical & Health Exam Prep' },
  { channelId: 'UCgYImB0onaBVHF_Ml_XnoDg', channelName: 'Teachers By Unacademy', category: 'Teaching & Education Exam Prep' },
  { channelId: 'UCrC8mOqJQpoB7NuIMKIS6rQ', channelName: 'StudyIQ IAS', category: 'Administrative & Civil Services' },
  { channelId: 'UCxGJuLJzqYuem5LkWII_HOg', channelName: 'MatSci Odia by Basant Sir', category: 'Odia School' },
  { channelId: 'UCpODgTsBXzuW2ka2xt-wcYg', channelName: 'Odisha High School Education', category: 'Odia School' },
  { channelId: 'UCc5whtb5eLlPOBxHClAPVUw', channelName: 'NPTEL', category: 'College & Higher Education' },
  { channelId: 'UC1emV4A8liRs9p80CY8ElUQ', channelName: 'freeCodeCamp.org', category: 'Software Skills' },
  { channelId: 'UCJQJ4GjTiq5lmn8czf8oo0Q', channelName: 'PowerCert Animated Videos', category: 'Hardware Skills' },
  { channelId: 'UCN1P0emdLodutAojnwswVYQ', channelName: 'SkillTrain India', category: 'Vocational Skills' },
  { channelId: 'UCvys9ZbQdJjcPgBpmSO0CYA', channelName: 'Skill Bill (Tally/GST)', category: 'Commercial & Business' },
];
