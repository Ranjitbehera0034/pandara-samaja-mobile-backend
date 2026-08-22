import dotenv from 'dotenv';
dotenv.config();

const required = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
};

export const JWT_SECRET = required('JWT_SECRET');
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
// Combined with a silent refresh call on app launch (see AuthContext.tsx),
// this still keeps active members logged in indefinitely — the token just
// renews itself every time they open the app. Shortened from 365d to 30d
// to cap how long a lost/stolen device or leaked token stays valid; a
// member who genuinely doesn't open the app for 30+ days just has to
// re-verify OTP once, same as the original OTP-login flow.
export const PORTAL_JWT_EXPIRES = process.env.PORTAL_JWT_EXPIRES || '30d';
export const PORT = parseInt(process.env.PORT || '6000');
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY || '';
export const BYPASS_FIREBASE_OTP = process.env.BYPASS_FIREBASE_OTP === 'true';

// LiveKit Cloud (live streaming) — optional. Left unset, live-streaming
// routes respond with a clear "not configured" error instead of crashing
// the server, same graceful-degradation pattern as email/push.
//
// .trim() guards against a real failure mode: a copy-pasted key/secret/URL
// with a stray leading/trailing space or newline passes the truthiness
// check below but produces a token LiveKit Cloud silently rejects as
// invalid — the trimmed value is logged on startup (length + whether
// trimming actually changed anything) so a corrupted env var is visible
// in Render's logs without ever printing the secret itself.
function loadLiveKitVar(key: string): string {
  const raw = process.env[key] || '';
  const trimmed = raw.trim();
  if (trimmed) {
    const hadWhitespace = trimmed !== raw;
    console.log(`[livekit-config] ${key}: length=${trimmed.length}${hadWhitespace ? ' — WARNING: had leading/trailing whitespace, trimmed' : ''}`);
  }
  return trimmed;
}

export const LIVEKIT_API_KEY = loadLiveKitVar('LIVEKIT_API_KEY');
export const LIVEKIT_API_SECRET = loadLiveKitVar('LIVEKIT_API_SECRET');
export const LIVEKIT_URL = loadLiveKitVar('LIVEKIT_URL');

// Shared secret checked by src/routes/jobIngest.ts — the only caller is the
// scraper/ GitHub Action (no member/admin JWT applies to it). Left unset,
// the ingest routes reject every request rather than silently accepting
// unauthenticated writes.
export const JOB_INGEST_KEY = process.env.JOB_INGEST_KEY || '';

// This service's own public URL — used to self-ping and stop Render's
// Hobby-tier idle hibernation, same fix already proven in
// Pandara_news_backend/src/config.ts (a GitHub Actions cron backup was
// tried there first; its scheduled runs land 15-40 minutes apart in
// practice, not the configured 5 — unreliable as a keep-alive on its
// own). A setInterval inside the always-running process itself has no
// such external-scheduler delay.
export const SELF_URL = process.env.SELF_URL || 'https://pandara-samaja-mobile-backend.onrender.com';

