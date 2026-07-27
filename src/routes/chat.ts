import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as portalModel from '../models/portalModel';
import * as memberModel from '../models/memberModel';

export default async function chatRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate);

  // ── GET /api/portal/chat/contacts ──
  // Inbox: one row per contact with last message + unread count
  fastify.get('/chat/contacts', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const contacts = await portalModel.getChatContacts(req.user.membership_no);
      return reply.send({ success: true, contacts });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch chat contacts' });
    }
  });

  // ── GET /api/portal/chat/conversation/:memberId ──
  // Paginated message history; marks the requester's inbox from this contact as read
  fastify.get('/chat/conversation/:memberId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { memberId } = req.params as any;
    const { limit = '30', offset = '0' } = req.query as any;

    try {
      const messages = await portalModel.getConversation(
        req.user.membership_no,
        memberId,
        parseInt(limit, 10),
        parseInt(offset, 10)
      );
      return reply.send({ success: true, messages });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch conversation' });
    }
  });

  // ── GET /api/portal/chat/search?q= ──
  // Find a member to start a new chat with
  fastify.get('/chat/search', async (req: FastifyRequest, reply: FastifyReply) => {
    const { q } = req.query as any;
    if (!q || !q.trim()) {
      return reply.send({ success: true, members: [] });
    }

    try {
      const res = await memberModel.search(q.trim(), 20, 0);
      const members = res.rows
        .filter((m: any) => m.membership_no !== req.user.membership_no)
        .map((m: any) => ({
          membership_no: m.membership_no,
          name: m.name,
          profile_photo_url: m.profile_photo_url,
        }));
      return reply.send({ success: true, members });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to search members' });
    }
  });

  // ── PUT /api/portal/chat/read/:memberId ──
  // REST fallback for marking a thread read (socket 'mark_read' covers the live case)
  fastify.put('/chat/read/:memberId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { memberId } = req.params as any;
    try {
      await portalModel.markMessagesRead(req.user.membership_no, memberId);
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to mark messages read' });
    }
  });
}
