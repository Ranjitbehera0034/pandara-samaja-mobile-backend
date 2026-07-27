import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as portalModel from '../models/portalModel';

export default async function notificationsRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate);

  // ── GET /api/portal/notifications ──
  fastify.get('/notifications', async (req: FastifyRequest, reply: FastifyReply) => {
    const { limit = '20', offset = '0' } = req.query as any;
    try {
      const notifications = await portalModel.getNotifications(
        req.user.membership_no,
        parseInt(limit, 10),
        parseInt(offset, 10)
      );
      const unreadCount = await portalModel.getUnreadNotificationCount(req.user.membership_no);
      return reply.send({ success: true, notifications, unreadCount });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch notifications' });
    }
  });

  // ── GET /api/portal/notifications/unread-count ──
  fastify.get('/notifications/unread-count', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const count = await portalModel.getUnreadNotificationCount(req.user.membership_no);
      return reply.send({ success: true, count });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch unread count' });
    }
  });

  // ── PUT /api/portal/notifications/:id/read ──
  fastify.put('/notifications/:id/read', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      await portalModel.markNotificationRead(id, req.user.membership_no);
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to mark notification read' });
    }
  });

  // ── PUT /api/portal/notifications/read-all ──
  fastify.put('/notifications/read-all', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await portalModel.markAllNotificationsRead(req.user.membership_no);
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to mark all notifications read' });
    }
  });

  // ── DELETE /api/portal/notifications/:id ──
  fastify.delete('/notifications/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      await portalModel.deleteNotification(id, req.user.membership_no);
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to delete notification' });
    }
  });
}
