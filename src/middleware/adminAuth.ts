import { FastifyRequest, FastifyReply } from 'fastify';

export async function verifyAdmin(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
    if (request.user?.type !== 'admin') {
      return reply.status(403).send({ success: false, message: 'Forbidden: Access restricted to administrators' });
    }
  } catch (err) {
    return reply.status(401).send({ success: false, message: 'Unauthorized' });
  }
}
