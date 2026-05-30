import fp from 'fastify-plugin';
import fastifyRateLimit from '@fastify/rate-limit';

export default fp(async (fastify) => {
  fastify.register(fastifyRateLimit, {
    global: true,
    max: 100,           // 100 requests per minute globally
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      success: false,
      message: 'Too many requests. Please slow down.',
    }),
  });
});
