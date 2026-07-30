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

  // ── GET /api/portal/family-members ── list the logged-in member's household roster
  fastify.get('/family-members', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const familyMembers = await memberModel.getFamilyMembers(req.user.membership_no);
      if (familyMembers === null) {
        return reply.status(404).send({ success: false, message: 'Member not found' });
      }
      return reply.send({ success: true, familyMembers });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch family members' });
    }
  });

  // ── POST /api/portal/family-members ── add a person to the logged-in member's household
  fastify.post('/family-members', async (req: FastifyRequest, reply: FastifyReply) => {
    const { name, relation, gender, age, marital_status } = req.body as any;
    if (!name || !relation) {
      return reply.status(400).send({ success: false, message: 'name and relation are required' });
    }
    try {
      const familyMembers = await memberModel.addFamilyMember(req.user.membership_no, { name, relation, gender, age, marital_status });
      if (familyMembers === null) {
        return reply.status(404).send({ success: false, message: 'Member not found' });
      }

      await logActivity({
        actorType: 'member',
        actorId: req.user.membership_no,
        action: 'family_member_added',
        req,
      });

      return reply.send({ success: true, familyMembers });
    } catch (err: any) {
      if (err?.message === 'A household can only have one head of family entry') {
        return reply.status(400).send({ success: false, message: err.message });
      }
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to add family member' });
    }
  });

  // ── PUT /api/portal/family-members/:index ── edit a person in the logged-in member's household
  fastify.put('/family-members/:index', async (req: FastifyRequest, reply: FastifyReply) => {
    const { index } = req.params as any;
    const { name, relation, gender, age, marital_status } = req.body as any;
    const idx = parseInt(index, 10);
    if (isNaN(idx)) {
      return reply.status(400).send({ success: false, message: 'index must be a number' });
    }
    try {
      const familyMembers = await memberModel.updateFamilyMember(req.user.membership_no, idx, { name, relation, gender, age, marital_status });
      if (familyMembers === null) {
        return reply.status(404).send({ success: false, message: 'Member or family member index not found' });
      }

      await logActivity({
        actorType: 'member',
        actorId: req.user.membership_no,
        action: 'family_member_updated',
        req,
      });

      return reply.send({ success: true, familyMembers });
    } catch (err: any) {
      if (err?.message === "Cannot change the head of family's own relation") {
        return reply.status(400).send({ success: false, message: err.message });
      }
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update family member' });
    }
  });

  // ── DELETE /api/portal/family-members/:index ── remove a person from the logged-in member's household
  fastify.delete('/family-members/:index', async (req: FastifyRequest, reply: FastifyReply) => {
    const { index } = req.params as any;
    const idx = parseInt(index, 10);
    if (isNaN(idx)) {
      return reply.status(400).send({ success: false, message: 'index must be a number' });
    }
    try {
      const familyMembers = await memberModel.removeFamilyMember(req.user.membership_no, idx);
      if (familyMembers === null) {
        return reply.status(404).send({ success: false, message: 'Member or family member index not found' });
      }

      await logActivity({
        actorType: 'member',
        actorId: req.user.membership_no,
        action: 'family_member_removed',
        req,
      });

      return reply.send({ success: true, familyMembers });
    } catch (err: any) {
      if (err?.message === 'Cannot remove the head of family') {
        return reply.status(400).send({ success: false, message: err.message });
      }
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to remove family member' });
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
