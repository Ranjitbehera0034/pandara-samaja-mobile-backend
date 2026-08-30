import cron from 'node-cron';
import { FastifyInstance } from 'fastify';
import * as liveStreamModel from '../models/liveStreamModel';
import { getLiveKitRoomService, isLiveKitConfigured } from './livekit';

// Safety net for streams that never got cleaned up client-side (app
// crashed/killed mid-broadcast, connection failed before the client could
// call the end endpoint, etc.) — see the Aug 2026 LiveKit credential outage,
// which left several such rows stuck "active" forever with 0 viewers.
//
// LiveKit itself is the source of truth here, not our own viewer-count
// socket rooms (those are in-memory and reset on every server restart).
// A stream past the grace period with zero real LiveKit participants —
// meaning not even the host is connected — is dead and gets auto-ended.
const CHECK_CRON = '*/3 * * * *'; // every 3 minutes
const GRACE_PERIOD_MS = 2 * 60 * 1000; // don't touch a stream in its first 2 minutes

async function reapOnce(fastify: FastifyInstance) {
  if (!isLiveKitConfigured()) return;

  const streams = await liveStreamModel.getActiveLiveStreams();
  const svc = getLiveKitRoomService();

  for (const stream of streams) {
    const startedAt = new Date(stream.started_at).getTime();
    if (Date.now() - startedAt < GRACE_PERIOD_MS) continue;

    let isDead = false;
    try {
      const participants = await svc.listParticipants(stream.room_name);
      isDead = participants.length === 0;
    } catch (err: any) {
      // Room genuinely doesn't exist on LiveKit's side → dead. Any other
      // error (network blip, LiveKit hiccup) is inconclusive — skip this
      // stream this cycle rather than risk ending a real live broadcast.
      if (err?.status === 404 || err?.code === 'not_found') {
        isDead = true;
      } else {
        continue;
      }
    }

    if (!isDead) continue;

    const ended = await liveStreamModel.endLiveStream(stream.room_name, stream.host_id);
    if (ended) {
      fastify.log.warn(`[live-reaper] Auto-ended orphaned stream ${stream.room_name} (host ${stream.host_id}, no LiveKit participants)`);
      const io = fastify.io;
      if (io) io.emit('live_ended', { roomName: stream.room_name });
    }
  }
}

export function initLiveStreamReaper(fastify: FastifyInstance) {
  cron.schedule(CHECK_CRON, () => {
    reapOnce(fastify).catch((err) => fastify.log.error({ err }, '[live-reaper] Sweep failed'));
  });

  console.log(`[live-reaper] Orphaned live-stream sweep scheduled: "${CHECK_CRON}"`);
}
