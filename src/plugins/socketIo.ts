import fp from 'fastify-plugin';
import fastifySocketIO from 'fastify-socket.io';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/secrets';
import * as portalModel from '../models/portalModel';
import { sendPushToPerson } from '../utils/pushNotifications';

// Track online users: { "membership_no:mobile" (or "admin_<id>"): Set<socketId> }
const onlineUsers = new Map<string, Set<string>>();

// Chat is per-person: two family members sharing a membership_no must land
// in different rooms. Admin sockets have no mobile and keep the legacy
// room name — they only ever join live-stream rooms, never chat ones.
const chatKey = (id: string, mobile?: string) => (mobile ? `${id}:${mobile}` : id);
const chatRoom = (id: string, mobile?: string) => `user:${chatKey(id, mobile)}`;

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
      socket.data = socket.data || {};
      if (decoded.type === 'member_portal') {
        socket.data.userId = decoded.membership_no;
        socket.data.mobile = decoded.mobile;
        socket.data.userName = decoded.name;
        socket.data.userType = 'member';
      } else if (decoded.type === 'admin') {
        // Prefixed so an admin's socket id can never collide with a member's
        // membership_no in onlineUsers/user:<id> rooms — admin/superadmin
        // only use this connection for live-stream comments, not chat.
        socket.data.userId = `admin_${decoded.id}`;
        socket.data.userName = decoded.username;
        socket.data.userType = decoded.role === 'superadmin' ? 'superadmin' : 'admin';
      } else {
        return next(new Error('Invalid token type'));
      }
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  // ── Connection handler ──
  fastify.io.on('connection', (socket: any) => {
    const authenticatedId = socket.data.userId;
    const authenticatedMobile = socket.data.mobile as string | undefined;
    const myKey = chatKey(authenticatedId, authenticatedMobile);
    fastify.log.info(`[SOCKET] Connected: ${myKey}`);

    // ── join_chat ──
    socket.on('join_chat', ({ userId }: { userId: string }) => {
      if (userId !== authenticatedId) {
        socket.emit('error', { message: 'User ID mismatch' });
        return;
      }
      if (!onlineUsers.has(myKey)) {
        onlineUsers.set(myKey, new Set());
      }
      onlineUsers.get(myKey)!.add(socket.id);
      socket.join(chatRoom(authenticatedId, authenticatedMobile));
      fastify.io.emit('user_online', { userId: authenticatedId, mobile: authenticatedMobile });
    });

    // ── send_message ──
    socket.on('send_message', async ({ receiverId, receiverMobile, content, type }: any) => {
      if (!authenticatedId || !authenticatedMobile || !receiverId || !receiverMobile || !content) return;

      try {
        const blocked = await portalModel.isChatBlocked(authenticatedId, authenticatedMobile, receiverId, receiverMobile);
        if (blocked) {
          socket.emit('message_error', { error: 'You cannot message this person' });
          return;
        }

        const savedMsg = await portalModel.saveMessage(
          authenticatedId, authenticatedMobile, receiverId, receiverMobile, content.trim(), type || 'text'
        );
        const senderProfile = await portalModel.getPersonIdentity(authenticatedId, authenticatedMobile);

        const messagePayload = {
          id: savedMsg.id.toString(),
          senderId: savedMsg.sender_id,
          senderMobile: savedMsg.sender_mobile,
          senderName: senderProfile?.name || socket.data.userName || 'Unknown',
          senderAvatar: senderProfile?.avatar || null,
          receiverId: savedMsg.receiver_id,
          receiverMobile: savedMsg.receiver_mobile,
          content: savedMsg.content,
          timestamp: savedMsg.created_at,
          read: false,
          type: savedMsg.type,
        };

        fastify.io.to(chatRoom(receiverId, receiverMobile)).emit('receive_message', messagePayload);
        socket.emit('message_sent', messagePayload);

        // Notification
        await portalModel.createNotification(receiverId, 'message', authenticatedId, 'sent you a message', null, senderProfile?.name || socket.data.userName, authenticatedMobile);
        const unread = await portalModel.getUnreadNotificationCount(receiverId);
        fastify.io.to(chatRoom(receiverId, receiverMobile)).emit('notification_count', { count: unread });

        // Push notification — fire-and-forget, must never break message delivery.
        // Targets the specific RECEIVER's own device (sendPushToPerson), not
        // the whole household — using membership_no alone here previously
        // meant a message to one family member could push straight to
        // whichever sibling's device last registered the shared token,
        // including the sender's own.
        const excerpt = content.trim().length > 60 ? content.trim().substring(0, 60) + '...' : content.trim();
        sendPushToPerson(
          receiverId,
          receiverMobile,
          senderProfile?.name || 'New message',
          excerpt || 'Sent you a message',
          { type: 'message', fromId: authenticatedId, fromMobile: authenticatedMobile }
        ).catch(() => { /* sendPushToPerson never throws, but be defensive */ });
      } catch (err: any) {
        fastify.log.error(err, '[SOCKET] send_message error');
        socket.emit('message_error', { error: 'Failed to send message' });
      }
    });

    // ── typing_start / typing_stop ──
    socket.on('typing_start', ({ receiverId, receiverMobile }: any) => {
      fastify.io.to(chatRoom(receiverId, receiverMobile)).emit('typing_start', { senderId: authenticatedId, senderMobile: authenticatedMobile });
    });
    socket.on('typing_stop', ({ receiverId, receiverMobile }: any) => {
      fastify.io.to(chatRoom(receiverId, receiverMobile)).emit('typing_stop', { senderId: authenticatedId, senderMobile: authenticatedMobile });
    });

    // ── mark_read ──
    socket.on('mark_read', async ({ senderId, senderMobile }: any) => {
      if (!senderId || !senderMobile) return;
      try {
        await portalModel.markMessagesRead(authenticatedId, authenticatedMobile!, senderId, senderMobile);
        fastify.io.to(chatRoom(senderId, senderMobile)).emit('messages_read', { readerId: authenticatedId, readerMobile: authenticatedMobile });
      } catch (err: any) {
        fastify.log.error(err, '[SOCKET] mark_read error');
      }
    });

    // ── get_online_users ──
    socket.on('get_online_users', () => {
      socket.emit('online_users', Array.from(onlineUsers.keys()));
    });

    // ── Live stream comments — ephemeral only, never written to the DB
    // (live streams themselves are never recorded/saved, by design). ──
    socket.on('join_live', ({ roomName }: any) => {
      if (!roomName) return;
      socket.join(`live:${roomName}`);
      const count = fastify.io.sockets.adapter.rooms.get(`live:${roomName}`)?.size || 0;
      fastify.io.to(`live:${roomName}`).emit('live_viewer_count', { roomName, count });
    });

    socket.on('leave_live', ({ roomName }: any) => {
      if (!roomName) return;
      socket.leave(`live:${roomName}`);
      const count = fastify.io.sockets.adapter.rooms.get(`live:${roomName}`)?.size || 0;
      fastify.io.to(`live:${roomName}`).emit('live_viewer_count', { roomName, count });
    });

    socket.on('live_comment', ({ roomName, text }: any) => {
      if (!roomName || !text?.trim()) return;
      fastify.io.to(`live:${roomName}`).emit('live_comment', {
        id: `${Date.now()}_${socket.id}`,
        senderId: authenticatedId,
        senderName: socket.data.userName || 'Someone',
        text: text.trim().slice(0, 500),
        at: new Date().toISOString(),
      });
    });

    // ── disconnect ──
    socket.on('disconnect', () => {
      if (onlineUsers.has(myKey)) {
        onlineUsers.get(myKey)!.delete(socket.id);
        if (onlineUsers.get(myKey)!.size === 0) {
          onlineUsers.delete(myKey);
          fastify.io.emit('user_offline', { userId: authenticatedId, mobile: authenticatedMobile });
        }
      }
    });
  });

  fastify.log.info('[SOCKET] Socket.io initialized');
});
