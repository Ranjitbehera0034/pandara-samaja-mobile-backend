import { FastifyRequest, FastifyReply } from 'fastify';

export async function verifyPortalMember(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
    if (request.user?.type !== 'member_portal') {
      return reply.status(403).send({ success: false, message: 'Forbidden: Access restricted to portal members' });
    }
  } catch (err) {
    return reply.status(401).send({ success: false, message: 'Unauthorized' });
  }
}
