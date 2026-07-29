import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as portalModel from '../models/portalModel';
import * as communityModel from '../models/communityModel';
import * as memberModel from '../models/memberModel';
import { uploadToFirebase, getSignedMediaUrl, UPLOAD_PATHS } from '../utils/firebaseStorage';
import { readMultipartFiles } from '../utils/multipart';
import { logActivity } from '../utils/activityLog';

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

  // ── PUT /api/portal/me/photo ── self-service profile photo update
  fastify.put('/me/photo', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { files } = await readMultipartFiles(req, ['photo']);
      if (files.photo.length === 0) {
        return reply.status(400).send({ success: false, message: 'A photo file is required' });
      }

      const url = await uploadToFirebase(files.photo[0], `members/${req.user.membership_no}/profile`);
      await memberModel.update(req.user.membership_no, { profile_photo_url: url });

      await logActivity({
        actorType: 'member',
        actorId: req.user.membership_no,
        action: 'profile_photo_updated',
        req,
      });

      return reply.send({ success: true, profile_photo_url: await getSignedMediaUrl(url) });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update profile photo' });
    }
  });

  // ── GET /api/portal/explore/stats ──
  fastify.get('/explore/stats', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const stats = await communityModel.getExploreStats();
      return reply.send({
        success: true,
        stats: {
          active_members: stats.activeMembers,
          trending_tags: [
            { name: '#community', count: 10 },
            { name: '#events', count: 5 }
          ]
        }
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch explore stats' });
    }
  });
}
