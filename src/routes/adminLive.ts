import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as liveStreamModel from '../models/liveStreamModel';
import { verifyAdmin } from '../middleware/adminAuth';
import { logActivity } from '../utils/activityLog';
import { broadcastPushToAllMembers } from '../utils/pushNotifications';
import { createLiveKitToken, isLiveKitConfigured, getLiveKitRoomService, LIVEKIT_URL } from '../utils/livekit';

export default async function adminLiveRoutes(fastify: FastifyInstance) {
  // ── POST /api/admin/live/start ── admin/superadmin going live
  fastify.post('/live/start', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLiveKitConfigured()) {
      return reply.status(503).send({ success: false, message: 'Live streaming is not configured yet.' });
    }
    const actor = req.user as any;
    const { title } = (req.body as any) || {};
    const hostId = String(actor.id);
    const roomName = `live_admin_${hostId}_${Date.now()}`;
    const hostType = actor.role === 'superadmin' ? 'superadmin' : 'admin';

    try {
      const stream = await liveStreamModel.startLiveStream({
        roomName,
        hostType,
        hostId,
        hostName: actor.username,
        title: title?.trim() || undefined,
      });

      const token = await createLiveKitToken(roomName, hostId, actor.username || 'Broadcaster', true);

      await logActivity({
        actorType: hostType,
        actorId: hostId,
        action: 'live_started',
        targetType: 'live_stream',
        targetId: roomName,
        req,
      });

      const io = fastify.io;
      if (io) io.emit('live_started', stream);

      broadcastPushToAllMembers(
        `${actor.username || 'Admin'} is live now`,
        title?.trim() || 'Tap to join the live stream',
        { type: 'live_started', roomName }
      ).catch(() => { /* never throws, defensive only */ });

      return reply.status(201).send({ success: true, room: stream, token, wsUrl: LIVEKIT_URL });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to start live stream' });
    }
  });

  // ── POST /api/admin/live/:roomName/end ── ends your own admin-hosted stream
  fastify.post('/live/:roomName/end', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { roomName } = req.params as any;
    const actor = req.user as any;
    try {
      const ended = await liveStreamModel.endLiveStream(roomName, String(actor.id));
      if (!ended) return reply.status(404).send({ success: false, message: 'Live stream not found' });

      const io = fastify.io;
      if (io) io.emit('live_ended', { roomName });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to end live stream' });
    }
  });

  // ── DELETE /api/admin/live/:roomName ── moderation: force-end ANY stream,
  // regardless of who's hosting it (member or another admin).
  fastify.delete('/live/:roomName', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { roomName } = req.params as any;
    const actor = req.user as any;
    try {
      const stream = await liveStreamModel.getLiveStreamByRoom(roomName);
      if (!stream) return reply.status(404).send({ success: false, message: 'Live stream not found' });

      const ended = await liveStreamModel.endLiveStream(roomName, stream.host_id);
      if (!ended) return reply.status(404).send({ success: false, message: 'Live stream not found' });

      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: 'live_force_ended',
        targetType: 'live_stream',
        targetId: roomName,
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

  // ── GET /api/admin/live/active ──
  fastify.get('/live/active', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const streams = await liveStreamModel.getActiveLiveStreams();
      return reply.send({ success: true, streams });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch active live streams' });
    }
  });

  // ── GET /api/admin/live/:roomName/participants ── who's currently
  // watching, straight from LiveKit itself (the real source of truth for
  // who actually holds a live connection, not just who once got a token).
  fastify.get('/live/:roomName/participants', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLiveKitConfigured()) {
      return reply.status(503).send({ success: false, message: 'Live streaming is not configured yet.' });
    }
    const { roomName } = req.params as any;
    const actor = req.user as any;
    try {
      const svc = getLiveKitRoomService();
      const participants = await svc.listParticipants(roomName);
      const viewers = participants
        .filter((p) => p.identity !== String(actor.id)) // exclude the host themselves
        .map((p) => ({ identity: p.identity, name: p.name || p.identity, joinedAt: Number(p.joinedAt) }));
      return reply.send({ success: true, viewers });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch viewers' });
    }
  });

  // ── POST /api/admin/live/:roomName/kick ── disconnect one viewer from
  // the LiveKit room only. This never touches their app account — no ban,
  // no login change, they can rejoin a future stream normally.
  fastify.post('/live/:roomName/kick', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLiveKitConfigured()) {
      return reply.status(503).send({ success: false, message: 'Live streaming is not configured yet.' });
    }
    const { roomName } = req.params as any;
    const { identity } = (req.body as any) || {};
    const actor = req.user as any;
    if (!identity?.trim()) {
      return reply.status(400).send({ success: false, message: 'identity is required' });
    }
    try {
      const svc = getLiveKitRoomService();
      await svc.removeParticipant(roomName, identity.trim());

      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: 'live_viewer_removed',
        targetType: 'live_stream',
        targetId: roomName,
        req,
      });

      return reply.send({ success: true });
    } catch (err: any) {
      // LiveKit throws a 404-shaped error if the participant already left —
      // treat that as success, not a failure the host needs to see.
      if (err?.status === 404 || err?.code === 'not_found') {
        return reply.send({ success: true });
      }
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to remove viewer' });
    }
  });
}
