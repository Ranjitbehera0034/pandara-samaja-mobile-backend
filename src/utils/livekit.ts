import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
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

// Server-side room control (list/remove participants, check room state) —
// needs the http(s) form of the URL, not the wss:// one clients connect with.
let roomService: RoomServiceClient | null = null;
export const getLiveKitRoomService = (): RoomServiceClient => {
  if (!roomService) {
    const httpUrl = LIVEKIT_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    roomService = new RoomServiceClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  }
  return roomService;
};

export { LIVEKIT_URL };
