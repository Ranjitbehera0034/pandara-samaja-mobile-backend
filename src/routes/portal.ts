import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as portalModel from '../models/portalModel';

export default async function portalRoutes(fastify: FastifyInstance) {

  // All portal routes require authentication
  fastify.addHook('preHandler', fastify.authenticate);

  // ── GET /api/portal/me ──
  // Get current logged-in member's full profile
  fastify.get('/me', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const membershipNo = req.user.membership_no;
      const member = await portalModel.getMemberProfile(membershipNo);

      if (!member) {
        return reply.status(404).send({ success: false, message: 'Member not found' });
      }

      const userProfile = await portalModel.getLoggedUserProfile(membershipNo);

      return reply.send({
        success: true,
        member,
        loggedInUser: userProfile || {
          name: req.user.name,
          relation: 'Head',
        },
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Internal server error' });
    }
  });
}
