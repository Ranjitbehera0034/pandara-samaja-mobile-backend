import fp from 'fastify-plugin';
import fastifyRateLimit from '@fastify/rate-limit';
import jwt from 'jsonwebtoken';

// Many Indian mobile carriers put a large number of distinct subscribers
// behind one shared public IP (carrier-grade NAT) — the same reasoning
// already applied to /login and /verify-otp in auth.ts. Keying this
// GLOBAL limit by IP alone means a burst of genuinely different members
// on the same carrier network sharing a feed/story/chat request at the
// same time could collectively exhaust one IP's bucket and get falsely
// throttled, even though the backend itself isn't under real strain.
//
// Fix: key by IP + whatever identity is in the request's JWT, when
// present. `jwt.decode` (not `verify`) is enough here — this is a
// fairness bucket, not an auth check, so an unverified payload is fine;
// worst case an attacker picks their own bucket key, which doesn't help
// them evade the limit. Requests with no/invalid token (public routes,
// pre-login) fall back to IP-only, same as before.
function rateLimitKey(req: any): string {
  const authHeader = req.headers?.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    try {
      const decoded = jwt.decode(authHeader.slice(7)) as any;
      const identity = decoded?.membership_no || (decoded?.type === 'admin' ? `admin:${decoded.id}` : null);
      if (identity) return `${req.ip}:${identity}`;
    } catch {
      // fall through to IP-only
    }
  }
  return req.ip;
}

export default fp(async (fastify) => {
  fastify.register(fastifyRateLimit, {
    global: true,
    max: 100,           // 100 requests per minute per key
    timeWindow: '1 minute',
    keyGenerator: rateLimitKey,
    errorResponseBuilder: () => ({
      success: false,
      message: 'Too many requests. Please slow down.',
    }),
  });
});
