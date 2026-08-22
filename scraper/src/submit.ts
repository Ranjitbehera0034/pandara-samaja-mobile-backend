import axios from 'axios';
import { StructuredJob } from './types';

const BACKEND_URL = process.env.BACKEND_URL || '';
const JOB_INGEST_KEY = process.env.JOB_INGEST_KEY || '';

function client() {
  if (!BACKEND_URL || !JOB_INGEST_KEY) {
    throw new Error('BACKEND_URL and JOB_INGEST_KEY must be set');
  }
  return axios.create({
    baseURL: BACKEND_URL,
    headers: { 'x-ingest-key': JOB_INGEST_KEY },
    timeout: 15000,
  });
}

export async function fetchSeenSourceRefs(source: string): Promise<Set<string>> {
  const res = await client().get('/api/ingest/jobs/seen', { params: { source } });
  return new Set<string>(res.data.seen || []);
}

export async function submitJob(job: StructuredJob, sourceRef: string, fallbackListingTitle: string): Promise<boolean> {
  if (!job.isVacancyNotice) return false;

  try {
    await client().post('/api/ingest/jobs', {
      title: job.title || fallbackListingTitle,
      organization: job.organization || 'Government of India',
      description: buildDescription(job),
      location: job.location,
      applicationInfo: job.applicationInfo || job.eligibility || 'See the original notice on the issuing department\'s website.',
      sourceRef,
    });
    return true;
  } catch (err: any) {
    if (err?.response?.status === 409) {
      // Already ingested — a race with another run, not an error.
      return false;
    }
    console.error(`[submit] Failed to submit ${sourceRef}:`, err?.response?.data || err.message);
    return false;
  }
}

function buildDescription(job: StructuredJob): string {
  const parts = [job.description, job.eligibility ? `Eligibility: ${job.eligibility}` : null, job.lastDate ? `Last date to apply: ${job.lastDate}` : null];
  return parts.filter(Boolean).join('\n\n') || 'See the original notice for full details.';
}
