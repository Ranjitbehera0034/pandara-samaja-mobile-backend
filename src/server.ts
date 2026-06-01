import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import dotenv from 'dotenv';
dotenv.config();

import { PORT, NODE_ENV } from './config/secrets';

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
  fastify.register(authRoutes, { prefix: '/api/portal' });
  fastify.register(portalRoutes, { prefix: '/api/portal' });
  fastify.register(feedRoutes, { prefix: '/api/portal' });
  fastify.register(announcementsRoutes, { prefix: '/api/posts' });

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
    await app.listen({ port: PORT, host: '0.0.0.0' });
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
