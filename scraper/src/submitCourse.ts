import axios from 'axios';

const BACKEND_URL = process.env.BACKEND_URL || '';
const COURSE_INGEST_KEY = process.env.COURSE_INGEST_KEY || '';

function client() {
  if (!BACKEND_URL || !COURSE_INGEST_KEY) {
    throw new Error('BACKEND_URL and COURSE_INGEST_KEY must be set');
  }
  return axios.create({
    baseURL: BACKEND_URL,
    headers: { 'x-ingest-key': COURSE_INGEST_KEY },
    timeout: 15000,
  });
}

export async function fetchSeenSourceRefs(): Promise<Set<string>> {
  const res = await client().get('/api/ingest/course-lessons/seen');
  return new Set<string>(res.data.seen || []);
}

export async function submitCourseLesson(video: {
  title: string;
  externalUrl: string;
  category: string;
  channelName: string;
  sourceRef: string;
}): Promise<boolean> {
  try {
    await client().post('/api/ingest/course-lessons', {
      title: video.title,
      platform: 'YouTube',
      externalUrl: video.externalUrl,
      category: video.category,
      channelName: video.channelName,
      sourceRef: video.sourceRef,
    });
    return true;
  } catch (err: any) {
    if (err?.response?.status === 409) {
      // Already ingested — a race with another run, not an error.
      return false;
    }
    console.error(`[submitCourse] Failed to submit ${video.sourceRef}:`, err?.response?.data || err.message);
    return false;
  }
}
