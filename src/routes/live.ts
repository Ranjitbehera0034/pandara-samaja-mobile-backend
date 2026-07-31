import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as liveStreamModel from '../models/liveStreamModel';
import { logActivity } from '../utils/activityLog';
import { broadcastPushToAllMembers } from '../utils/pushNotifications';
import { createLiveKitToken, isLiveKitConfigured, LIVEKIT_URL } from '../utils/livekit';

export default async function liveRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate);

  // ── POST /api/portal/live/start ──
  fastify.post('/live/start', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLiveKitConfigured()) {
      return reply.status(503).send({ success: false, message: 'Live streaming is not configured yet.' });
    }
    const { title } = (req.body as any) || {};
    const hostId = req.user.membership_no;
    const roomName = `live_${hostId}_${Date.now()}`;

    try {
      const stream = await liveStreamModel.startLiveStream({
        roomName,
        hostType: 'member',
        hostId,
        hostName: req.user.name,
        hostPhoto: req.user.photo,
        title: title?.trim() || undefined,
      });

      const token = await createLiveKitToken(roomName, hostId, req.user.name || 'Broadcaster', true);

      await logActivity({
        actorType: 'member',
        actorId: hostId,
        action: 'live_started',
        targetType: 'live_stream',
        targetId: roomName,
        actorName: req.user.name,
        req,
      });

      const io = fastify.io;
      if (io) io.emit('live_started', stream);

      // Broadcast to everyone — a live stream is a discoverable, time-sensitive
      // moment, not something scoped to followers only.
      broadcastPushToAllMembers(
        `${req.user.name || 'Someone'} is live now`,
        title?.trim() || 'Tap to join the live stream',
        { type: 'live_started', roomName }
      ).catch(() => { /* never throws, defensive only */ });

      return reply.status(201).send({ success: true, room: stream, token, wsUrl: LIVEKIT_URL });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to start live stream' });
    }
  });

  // ── POST /api/portal/live/:roomName/end ──
  fastify.post('/live/:roomName/end', async (req: FastifyRequest, reply: FastifyReply) => {
    const { roomName } = req.params as any;
    try {
      const ended = await liveStreamModel.endLiveStream(roomName, req.user.membership_no);
      if (!ended) return reply.status(404).send({ success: false, message: 'Live stream not found' });

      await logActivity({
        actorType: 'member',
        actorId: req.user.membership_no,
        action: 'live_ended',
        targetType: 'live_stream',
        targetId: roomName,
        actorName: req.user.name,
        req,
      });

      const io = fastify.io;
      if (io) io.emit('live_ended', { roomName });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to end live stream' });
    }
  });

  // ── GET /api/portal/live/active ── currently-live streams, for feed discovery
  fastify.get('/live/active', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const streams = await liveStreamModel.getActiveLiveStreams();
      return reply.send({ success: true, streams });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch active live streams' });
    }
  });

  // ── GET /api/portal/live/:roomName/token ── viewer token (subscribe-only)
  fastify.get('/live/:roomName/token', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLiveKitConfigured()) {
      return reply.status(503).send({ success: false, message: 'Live streaming is not configured yet.' });
    }
    const { roomName } = req.params as any;
    try {
      const stream = await liveStreamModel.getLiveStreamByRoom(roomName);
      if (!stream) return reply.status(404).send({ success: false, message: 'This live stream has ended.' });

      const token = await createLiveKitToken(roomName, req.user.membership_no, req.user.name || 'Viewer', false);
      return reply.send({ success: true, room: stream, token, wsUrl: LIVEKIT_URL });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch viewer token' });
    }
  });
}
