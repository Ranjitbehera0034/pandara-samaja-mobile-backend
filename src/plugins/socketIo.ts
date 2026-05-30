import fp from 'fastify-plugin';
import fastifySocketIO from 'fastify-socket.io';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/secrets';
import * as portalModel from '../models/portalModel';

// Track online users: { membership_no: Set<socketId> }
const onlineUsers = new Map<string, Set<string>>();

export default fp(async (fastify) => {
  await fastify.register(fastifySocketIO, {
    cors: {
      origin: (origin, cb) => {
        // Allow mobile apps (no origin) + whitelisted origins
        if (!origin || origin === 'null') return cb(null, true);
        return cb(null, true); // Rely on HTTP CORS plugin for web
      },
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
  });

  // ── Authentication middleware ──
  fastify.io.use((socket: any, next: any) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      const decoded = jwt.verify(token as string, JWT_SECRET) as any;
      if (decoded.type !== 'member_portal') {
        return next(new Error('Invalid token type'));
      }
      socket.data = socket.data || {};
      socket.data.userId = decoded.membership_no;
      socket.data.userName = decoded.name;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  // ── Connection handler ──
  fastify.io.on('connection', (socket: any) => {
    const authenticatedId = socket.data.userId;
    fastify.log.info(`[SOCKET] Connected: ${authenticatedId}`);

    // ── join_chat ──
    socket.on('join_chat', ({ userId }: { userId: string }) => {
      if (userId !== authenticatedId) {
        socket.emit('error', { message: 'User ID mismatch' });
        return;
      }
      if (!onlineUsers.has(authenticatedId)) {
        onlineUsers.set(authenticatedId, new Set());
      }
      onlineUsers.get(authenticatedId)!.add(socket.id);
      socket.join(`user:${authenticatedId}`);
      fastify.io.emit('user_online', { userId: authenticatedId });
    });

    // ── send_message ──
    socket.on('send_message', async ({ receiverId, content, type }: any) => {
      if (!authenticatedId || !receiverId || !content) return;

      try {
        const savedMsg = await portalModel.saveMessage(authenticatedId, receiverId, content.trim(), type || 'text');
        const senderProfile = await portalModel.getMemberProfile(authenticatedId);

        const messagePayload = {
          id: savedMsg.id.toString(),
          senderId: savedMsg.sender_id,
          senderName: senderProfile?.name || 'Unknown',
          senderAvatar: senderProfile?.profile_photo_url || null,
          receiverId: savedMsg.receiver_id,
          content: savedMsg.content,
          timestamp: savedMsg.created_at,
          read: false,
          type: savedMsg.type,
        };

        fastify.io.to(`user:${receiverId}`).emit('receive_message', messagePayload);
        socket.emit('message_sent', messagePayload);

        // Notification
        await portalModel.createNotification(receiverId, 'message', authenticatedId, 'sent you a message', null);
        const unread = await portalModel.getUnreadNotificationCount(receiverId);
        fastify.io.to(`user:${receiverId}`).emit('notification_count', { count: unread });
      } catch (err: any) {
        fastify.log.error(err, '[SOCKET] send_message error');
        socket.emit('message_error', { error: 'Failed to send message' });
      }
    });

    // ── typing_start / typing_stop ──
    socket.on('typing_start', ({ receiverId }: any) => {
      fastify.io.to(`user:${receiverId}`).emit('typing_start', { senderId: authenticatedId });
    });
    socket.on('typing_stop', ({ receiverId }: any) => {
      fastify.io.to(`user:${receiverId}`).emit('typing_stop', { senderId: authenticatedId });
    });

    // ── mark_read ──
    socket.on('mark_read', async ({ senderId }: any) => {
      try {
        await portalModel.markMessagesRead(authenticatedId, senderId);
        fastify.io.to(`user:${senderId}`).emit('messages_read', { readerId: authenticatedId });
      } catch (err: any) {
        fastify.log.error(err, '[SOCKET] mark_read error');
      }
    });

    // ── get_online_users ──
    socket.on('get_online_users', () => {
      socket.emit('online_users', Array.from(onlineUsers.keys()));
    });

    // ── disconnect ──
    socket.on('disconnect', () => {
      if (authenticatedId && onlineUsers.has(authenticatedId)) {
        onlineUsers.get(authenticatedId)!.delete(socket.id);
        if (onlineUsers.get(authenticatedId)!.size === 0) {
          onlineUsers.delete(authenticatedId);
          fastify.io.emit('user_offline', { userId: authenticatedId });
        }
      }
    });
  });

  fastify.log.info('[SOCKET] Socket.io initialized');
});
