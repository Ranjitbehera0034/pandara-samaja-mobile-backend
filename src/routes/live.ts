import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as liveStreamModel from '../models/liveStreamModel';
import { createLiveKitToken, isLiveKitConfigured, LIVEKIT_URL } from '../utils/livekit';

// Member-facing live routes — view-only. Hosting a live stream is
// admin/superadmin-only (see routes/adminLive.ts); members can list active
// streams and get a subscribe-only viewer token, nothing else.
export default async function liveRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate);

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
