import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as portalModel from '../models/portalModel';
import * as memberModel from '../models/memberModel';
import { getSignedMediaUrl } from '../utils/firebaseStorage';

export default async function chatRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate);

  // ── GET /api/portal/chat/contacts ──
  // Inbox: one row per (contact_id, contact_mobile) person, with last message + unread count
  fastify.get('/chat/contacts', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const contacts = await portalModel.getChatContacts(req.user.membership_no, req.user.mobile!);
      return reply.send({ success: true, contacts });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch chat contacts' });
    }
  });

  // ── GET /api/portal/chat/unread-count ──
  // Total unread messages across all contacts — powers the Chat tab badge
  fastify.get('/chat/unread-count', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const count = await portalModel.getTotalUnreadMessageCount(req.user.membership_no, req.user.mobile!);
      return reply.send({ success: true, count });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch unread count' });
    }
  });

  // ── GET /api/portal/chat/conversation/:memberId?mobile=... ──
  // Paginated message history with one specific PERSON; marks it read
  fastify.get('/chat/conversation/:memberId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { memberId } = req.params as any;
    const { mobile, limit = '30', offset = '0' } = req.query as any;
    if (!mobile) {
      return reply.status(400).send({ success: false, message: 'mobile query param is required' });
    }

    try {
      const messages = await portalModel.getConversation(
        req.user.membership_no, req.user.mobile!,
        memberId, mobile,
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
  // Find ANYONE registered with their own mobile to start a new chat with —
  // not just household heads, any family member who has logged in with
  // their own number.
  fastify.get('/chat/search', async (req: FastifyRequest, reply: FastifyReply) => {
    const { q } = req.query as any;
    if (!q || !q.trim()) {
      return reply.send({ success: true, members: [] });
    }

    try {
      const rows = await memberModel.searchChatPeople(q.trim(), req.user.membership_no, req.user.mobile!, 20, 0);
      const members = await Promise.all(rows.map(async (r: any) => ({
        membership_no: r.membership_no,
        mobile: r.person_mobile,
        name: r.person_name,
        relation: r.relation,
        profile_photo_url: await getSignedMediaUrl(r.avatar),
        village: r.village,
      })));
      return reply.send({ success: true, members });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to search members' });
    }
  });

  // ── PUT /api/portal/chat/read/:memberId?mobile=... ──
  // REST fallback for marking a thread read (socket 'mark_read' covers the live case)
  fastify.put('/chat/read/:memberId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { memberId } = req.params as any;
    const { mobile } = req.query as any;
    if (!mobile) {
      return reply.status(400).send({ success: false, message: 'mobile query param is required' });
    }
    try {
      await portalModel.markMessagesRead(req.user.membership_no, req.user.mobile!, memberId, mobile);
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to mark messages read' });
    }
  });

  // ── POST /api/portal/chat/block ──
  // Block a specific person — stops them delivering new messages either way
  fastify.post('/chat/block', async (req: FastifyRequest, reply: FastifyReply) => {
    const { membershipNo, mobile } = req.body as any;
    if (!membershipNo || !mobile) {
      return reply.status(400).send({ success: false, message: 'membershipNo and mobile are required' });
    }
    try {
      await portalModel.createChatBlock(req.user.membership_no, req.user.mobile!, membershipNo, mobile);
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to block' });
    }
  });

  // ── DELETE /api/portal/chat/block?membershipNo=&mobile= ──
  fastify.delete('/chat/block', async (req: FastifyRequest, reply: FastifyReply) => {
    const { membershipNo, mobile } = req.query as any;
    if (!membershipNo || !mobile) {
      return reply.status(400).send({ success: false, message: 'membershipNo and mobile are required' });
    }
    try {
      await portalModel.removeChatBlock(req.user.membership_no, req.user.mobile!, membershipNo, mobile);
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to unblock' });
    }
  });

  // ── GET /api/portal/chat/blocked ──
  fastify.get('/chat/blocked', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const blocked = await portalModel.getBlockedByMe(req.user.membership_no, req.user.mobile!);
      return reply.send({ success: true, blocked });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch blocked list' });
    }
  });

  // ── POST /api/portal/chat/report ──
  // Report a sender for admin review — does not block automatically
  fastify.post('/chat/report', async (req: FastifyRequest, reply: FastifyReply) => {
    const { membershipNo, mobile, reason } = req.body as any;
    if (!membershipNo || !mobile) {
      return reply.status(400).send({ success: false, message: 'membershipNo and mobile are required' });
    }
    try {
      await portalModel.createChatReport(req.user.membership_no, req.user.mobile!, membershipNo, mobile, reason?.trim() || null);
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to submit report' });
    }
  });
}
