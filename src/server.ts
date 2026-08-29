import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import dotenv from 'dotenv';
dotenv.config();

import { PORT, NODE_ENV, SELF_URL } from './config/secrets';

// Plugins
import corsPlugin from './plugins/cors';
import jwtPlugin from './plugins/jwt';
import rateLimitPlugin from './plugins/rateLimit';
import multipartPlugin from './plugins/multipart';
import socketIoPlugin from './plugins/socketIo';

// Routes
import authRoutes from './routes/auth';
import portalRoutes from './routes/portal';
import feedRoutes from './routes/feed';
import announcementsRoutes from './routes/announcements';
import membersRoutes from './routes/members';
import findMembershipRoutes from './routes/findMembership';
import eventsRoutes from './routes/events';
import leadersRoutes from './routes/leaders';
import chatRoutes from './routes/chat';
import notificationsRoutes from './routes/notifications';
import adminRoutes from './routes/admin';
import familyRoutes from './routes/family';
import matrimonyRoutes from './routes/matrimony';
import adminActivityRoutes from './routes/adminActivity';
import adminAnalyticsRoutes from './routes/adminAnalytics';
import adminMatrimonyRoutes from './routes/adminMatrimony';
import adminMatrimonyApplicationsRoutes from './routes/adminMatrimonyApplications';
import adminPostsRoutes from './routes/adminPosts';
import adminAnnouncementsRoutes from './routes/adminAnnouncements';
import adminExpensesRoutes from './routes/adminExpenses';
import adminLeadersRoutes from './routes/adminLeaders';
import liveRoutes from './routes/live';
import adminLiveRoutes from './routes/adminLive';
import adminExportRoutes from './routes/adminExport';
import legalRoutes from './routes/legal';
import jobsRoutes from './routes/jobs';
import adminJobsRoutes from './routes/adminJobs';
import jobIngestRoutes from './routes/jobIngest';
import newsIngestRoutes from './routes/newsIngest';
import { initScheduledNotifications } from './utils/scheduledNotifications';
import { bootstrapDefaultAdmin } from './services/adminBootstrap';

const fastify = Fastify({
  logger: {
    level: NODE_ENV === 'production' ? 'warn' : 'info',
    transport: NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
});

async function buildServer() {
  // ── 1. Security & CORS ──
  await fastify.register(corsPlugin);
  await fastify.register(helmet);

  // ── 2. Rate Limiting ──
  await fastify.register(rateLimitPlugin);

  // ── 3. Body Parsing & File Upload ──
  await fastify.register(multipartPlugin);

  // ── 4. JWT ──
  await fastify.register(jwtPlugin);

  // ── 5. Socket.io ──
  await fastify.register(socketIoPlugin);

  // ── 6. Health Check ──
  fastify.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'pandara-samaja-mobile-backend',
    version: '2.0.0',
  }));

  // ── 7. Routes ──
  fastify.register(legalRoutes);
  fastify.register(authRoutes, { prefix: '/api/portal' });
  fastify.register(portalRoutes, { prefix: '/api/portal' });
  fastify.register(feedRoutes, { prefix: '/api/portal' });
  fastify.register(announcementsRoutes, { prefix: '/api/posts' });
  fastify.register(membersRoutes, { prefix: '/api/portal' });
  fastify.register(findMembershipRoutes, { prefix: '/api/portal' });
  fastify.register(eventsRoutes, { prefix: '/api/portal' });
  fastify.register(leadersRoutes, { prefix: '/api' });
  fastify.register(chatRoutes, { prefix: '/api/portal' });
  fastify.register(notificationsRoutes, { prefix: '/api/portal' });
  fastify.register(adminRoutes, { prefix: '/api/admin' });
  fastify.register(familyRoutes, { prefix: '/api/portal' });
  fastify.register(matrimonyRoutes, { prefix: '/api/portal' });
  fastify.register(adminActivityRoutes, { prefix: '/api/admin' });
  fastify.register(adminAnalyticsRoutes, { prefix: '/api/admin' });
  fastify.register(adminMatrimonyRoutes, { prefix: '/api/admin' });
  fastify.register(adminMatrimonyApplicationsRoutes, { prefix: '/api/admin' });
  fastify.register(adminPostsRoutes, { prefix: '/api/admin' });
  fastify.register(adminAnnouncementsRoutes, { prefix: '/api/admin' });
  fastify.register(adminExpensesRoutes, { prefix: '/api/admin' });
  fastify.register(adminLeadersRoutes, { prefix: '/api/admin' });
  fastify.register(liveRoutes, { prefix: '/api/portal' });
  fastify.register(adminLiveRoutes, { prefix: '/api/admin' });
  fastify.register(adminExportRoutes, { prefix: '/api/admin' });
  fastify.register(jobsRoutes, { prefix: '/api/portal' });
  fastify.register(adminJobsRoutes, { prefix: '/api/admin' });
  fastify.register(jobIngestRoutes, { prefix: '/api/ingest' });
  fastify.register(newsIngestRoutes, { prefix: '/api/ingest' });

  // ── 8. Global error handler ──
  fastify.setErrorHandler((error, request, reply) => {
    fastify.log.error(error);
    const statusCode = error.statusCode || 500;
    reply.status(statusCode).send({
      success: false,
      message: error.message || 'Internal server error',
    });
  });

  return fastify;
}

// ── Start ──
buildServer().then(async (app) => {
  try {
    await bootstrapDefaultAdmin();
    await app.listen({ port: PORT, host: '0.0.0.0' });
    initScheduledNotifications();

    // Self-ping every 4 minutes — comfortably inside Render's 15-minute
    // idle timeout on the Hobby plan. This gates login/feed/chat/every-
    // thing, so unlike the news backend (which relies on this alone),
    // this should be paired with external uptime monitoring too — see
    // ARCHITECTURE.md.
    setInterval(() => {
      fetch(`${SELF_URL}/health`).catch((err) => {
        app.log.warn({ err }, '[keep-alive] Self-ping failed');
      });
    }, 4 * 60 * 1000);

    console.log(`\n🚀 Pandara Samaja Mobile Backend v2.0`);
    console.log(`   Port:          ${PORT}`);
    console.log(`   Health:        http://localhost:${PORT}/health`);
    console.log(`   Feed:          http://localhost:${PORT}/api/portal/posts`);
    console.log(`   Announcements: http://localhost:${PORT}/api/posts`);
    console.log(`   Socket.io:     ws://localhost:${PORT}\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}).catch((err) => {
  console.error('Failed to build server:', err);
  process.exit(1);
});

export default fastify;
