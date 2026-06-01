import fp from 'fastify-plugin';
import fastifyCors from '@fastify/cors';
import { NODE_ENV } from '../config/secrets';

const allowedOriginsProd = [
  'https://nikhilaodishapandarasamaja.in',
  'https://www.nikhilaodishapandarasamaja.in',
];

const allowedOriginsDev = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8080',
];

export default fp(async (fastify) => {
  fastify.register(fastifyCors, {
    origin: (origin, cb) => {
      // Allow requests with no origin (mobile apps, Postman, curl)
      if (!origin || origin === 'null') return cb(null, true);

      // Allow localhost, local loopback, and local network IPs (needed for mobile Expo apps)
      const isLocalhost = /^https?:\/\/(?:localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[0-1])\.\d+\.\d+)(?::\d+)?$/i.test(origin);
      if (isLocalhost) return cb(null, true);

      const allowed = NODE_ENV === 'production'
        ? allowedOriginsProd
        : [...allowedOriginsDev, ...allowedOriginsProd];

      if (allowed.includes(origin)) return cb(null, true);

      // Allow any subdomain of nikhilaodishapandarasamaja.in
      const regex = /^https?:\/\/(?:.+\.)?nikhilaodishapandarasamaja\.in$/i;
      if (regex.test(origin)) return cb(null, true);

      return cb(new Error(`CORS blocked: ${origin}`), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false, // Mobile uses Bearer token, not cookies
  });
});
