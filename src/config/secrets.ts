import dotenv from 'dotenv';
dotenv.config();

const required = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
};

export const JWT_SECRET = required('JWT_SECRET');
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
// Long-lived by design: users should stay logged in indefinitely (like most
// social apps) rather than being forced to re-verify OTP periodically.
// Combined with a silent refresh call on app launch (see AuthContext.tsx),
// this means sessions only end on manual logout, a ban, or the member
// record disappearing — not on a timer.
export const PORTAL_JWT_EXPIRES = process.env.PORTAL_JWT_EXPIRES || '365d';
export const PORT = parseInt(process.env.PORT || '6000');
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY || '';
export const BYPASS_FIREBASE_OTP = process.env.BYPASS_FIREBASE_OTP === 'true';

// LiveKit Cloud (live streaming) — optional. Left unset, live-streaming
// routes respond with a clear "not configured" error instead of crashing
// the server, same graceful-degradation pattern as email/push.
export const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
export const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
export const LIVEKIT_URL = process.env.LIVEKIT_URL || '';

