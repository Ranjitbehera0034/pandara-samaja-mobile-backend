import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { NEWS_INGEST_KEY } from '../config/secrets';
import { broadcastPushToAllMembers } from '../utils/pushNotifications';

// Ingestion path for the news backend's own refresh loop (a separate
// Render service — see Pandara_news_backend/src/newsStore.ts — with no
// shared database, so it can't push directly). Called at most once per
// refresh cycle (every 20 minutes), only when a genuinely new top story
// appeared, never once per article — see newsStore.ts's own comment for
// why: a single refresh can surface 10-20+ "new" items, and pushing for
// every one would be exactly the notification-spam this project already
// worked to avoid elsewhere (see the notification primer in
// Pandara_mobile/src/utils/pushNotifications.ts).
export default async function newsIngestRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.headers['x-ingest-key'];
    if (!NEWS_INGEST_KEY || key !== NEWS_INGEST_KEY) {
      return reply.status(401).send({ success: false, message: 'Invalid or missing ingest key' });
    }
  });

  // ── POST /api/ingest/news-alert ── one top story, broadcasts a push to
  // every member with a registered token. imageUrl renders automatically
  // on Android (Expo richContent); iOS has no Notification Service
  // Extension yet, so the image is silently absent there, not an error.
  fastify.post('/news-alert', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body as any) || {};
    const { title, imageUrl, link } = body;

    if (!title?.trim()) {
      return reply.status(400).send({ success: false, message: 'title is required' });
    }

    try {
      await broadcastPushToAllMembers(
        title.trim(),
        'Tap to read the latest news',
        { type: 'news', link: link || null },
        undefined,
        imageUrl || null
      );
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to broadcast news alert' });
    }
  });
}
