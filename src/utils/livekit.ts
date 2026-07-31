import { AccessToken } from 'livekit-server-sdk';
import { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } from '../config/secrets';

let warned = false;
export const isLiveKitConfigured = (): boolean => {
  const ok = !!(LIVEKIT_API_KEY && LIVEKIT_API_SECRET && LIVEKIT_URL);
  if (!ok && !warned) {
    warned = true;
    console.warn('[LIVEKIT] LIVEKIT_API_KEY/LIVEKIT_API_SECRET/LIVEKIT_URL not set — live streaming disabled.');
  }
  return ok;
};

export const createLiveKitToken = async (
  roomName: string,
  identity: string,
  name: string,
  canPublish: boolean
): Promise<string> => {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, name, ttl: '6h' });
  at.addGrant({ roomJoin: true, room: roomName, canPublish, canSubscribe: true });
  return at.toJwt();
};

export { LIVEKIT_URL };
