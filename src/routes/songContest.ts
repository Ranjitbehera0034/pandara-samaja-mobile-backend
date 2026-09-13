import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as contestModel from '../models/songContestModel';
import { uploadToFirebase, UPLOAD_PATHS } from '../utils/firebaseStorage';
import { logActivity } from '../utils/activityLog';

// Member-facing Song Competition — registered under /api/portal. Admin
// launch/moderation lives in routes/adminSongContest.ts. See backend
// ARCHITECTURE.md's "Song Competition" section for the full design
// (moderation gate, one-group-per-village, why rounds aren't modeled yet).
//
// A song video is much longer than a typical post/story clip, so this
// route uses its own higher multipart size limit (50MB) rather than the
// app-wide 10MB cap from plugins/multipart.ts — raising the global cap
// would also loosen it for every post/story upload, which don't need it.
const SONG_VIDEO_SIZE_LIMIT = 50 * 1024 * 1024;

const VALID_ENTRY_TYPES = ['individual', 'group'];

export default async function songContestRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate);

  // ── GET /api/portal/song-contests ── visible (non-draft) contests
  fastify.get('/song-contests', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await contestModel.listVisibleContests();
      return reply.send({ success: true, contests: result.rows });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch contests' });
    }
  });

  // ── GET /api/portal/song-contests/:id ──
  fastify.get('/song-contests/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await contestModel.getContestById(id);
      const contest = result.rows[0];
      if (!contest || contest.status === 'draft') {
        return reply.status(404).send({ success: false, message: 'Contest not found' });
      }
      return reply.send({ success: true, contest });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch contest' });
    }
  });

  // ── GET /api/portal/song-contests/:id/my-entry ── null if not yet registered
  fastify.get('/song-contests/:id/my-entry', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await contestModel.getMyEntry(id, req.user.membership_no, req.user.mobile!);
      return reply.send({ success: true, entry: result.rows[0] || null });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch your entry' });
    }
  });

  // ── POST /api/portal/song-contests/:id/entries ── register + upload video.
  // Multipart: entryType, entryName, village (required for group), participantNames, video file.
  fastify.post('/song-contests/:id/entries', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;

    try {
      const contest = await contestModel.getContestById(id);
      if (!contest.rows[0] || contest.rows[0].status !== 'active') {
        return reply.status(400).send({ success: false, message: 'This contest is not open for registration' });
      }

      const existing = await contestModel.getMyEntry(id, req.user.membership_no, req.user.mobile!);
      if (existing.rows[0]) {
        return reply.status(409).send({ success: false, message: 'You have already registered for this contest' });
      }

      const parts = req.parts({ limits: { fileSize: SONG_VIDEO_SIZE_LIMIT } });
      let entryType = '';
      let entryName = '';
      let village = '';
      let participantNames = '';
      let videoUrl = '';

      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'entryType') entryType = part.value as string;
          if (part.fieldname === 'entryName') entryName = part.value as string;
          if (part.fieldname === 'village') village = part.value as string;
          if (part.fieldname === 'participantNames') participantNames = part.value as string;
        } else if (part.type === 'file' && part.fieldname === 'video') {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) chunks.push(chunk);
          const buffer = Buffer.concat(chunks);
          if (buffer.length > 0) {
            videoUrl = await uploadToFirebase(
              { buffer, originalname: part.filename || 'song.mp4', mimetype: part.mimetype },
              UPLOAD_PATHS.SONG_CONTEST(req.user.membership_no)
            );
          }
        }
      }

      if (!VALID_ENTRY_TYPES.includes(entryType)) {
        return reply.status(400).send({ success: false, message: 'entryType must be "individual" or "group"' });
      }
      if (!entryName?.trim()) {
        return reply.status(400).send({ success: false, message: 'entryName is required' });
      }
      if (entryType === 'group' && !village?.trim()) {
        return reply.status(400).send({ success: false, message: 'village is required for a group entry' });
      }
      if (!videoUrl) {
        return reply.status(400).send({ success: false, message: 'A video is required' });
      }

      let result;
      try {
        result = await contestModel.createEntry({
          contestId: id,
          entryType: entryType as 'individual' | 'group',
          entryName: entryName.trim(),
          village: village?.trim() || null,
          participantNames: participantNames?.trim() || null,
          registeredByMembershipNo: req.user.membership_no,
          registeredByMobile: req.user.mobile!,
          videoUrl,
        });
      } catch (err: any) {
        // Unique violation — either this village already has a group entry,
        // or this person already has a non-rejected entry (a race past the
        // getMyEntry check above).
        if (err?.code === '23505') {
          return reply.status(409).send({
            success: false,
            message: entryType === 'group'
              ? 'A group from this village has already registered for this contest'
              : 'You have already registered for this contest',
          });
        }
        throw err;
      }

      await logActivity({
        actorType: 'member',
        actorId: req.user.membership_no,
        action: 'song_contest_entry_submitted',
        targetType: 'song_contest_entry',
        targetId: String(result.rows[0].id),
        actorName: req.user.name,
        req,
      });

      return reply.status(201).send({ success: true, entry: result.rows[0] });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to submit your entry' });
    }
  });

  // ── GET /api/portal/song-contests/:id/entries ── approved entries, most-liked first
  fastify.get('/song-contests/:id/entries', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await contestModel.listApprovedEntries(id);
      const likedIds = await contestModel.getLikedEntryIds(id, req.user.membership_no, req.user.mobile!);
      const entries = result.rows.map((e: any) => ({ ...e, liked_by_me: likedIds.has(e.id) }));
      return reply.send({ success: true, entries });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch entries' });
    }
  });

  // ── POST /api/portal/song-contests/entries/:entryId/like ──
  fastify.post('/song-contests/entries/:entryId/like', async (req: FastifyRequest, reply: FastifyReply) => {
    const { entryId } = req.params as any;
    try {
      await contestModel.likeEntry(entryId, req.user.membership_no, req.user.mobile!);
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to like entry' });
    }
  });

  // ── DELETE /api/portal/song-contests/entries/:entryId/like ──
  fastify.delete('/song-contests/entries/:entryId/like', async (req: FastifyRequest, reply: FastifyReply) => {
    const { entryId } = req.params as any;
    try {
      await contestModel.unlikeEntry(entryId, req.user.membership_no, req.user.mobile!);
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to unlike entry' });
    }
  });

  // ── GET /api/portal/song-contests/entries/:entryId/comments ──
  fastify.get('/song-contests/entries/:entryId/comments', async (req: FastifyRequest, reply: FastifyReply) => {
    const { entryId } = req.params as any;
    try {
      const result = await contestModel.getComments(entryId);
      return reply.send({ success: true, comments: result.rows });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch comments' });
    }
  });

  // ── POST /api/portal/song-contests/entries/:entryId/comments ──
  fastify.post('/song-contests/entries/:entryId/comments', async (req: FastifyRequest, reply: FastifyReply) => {
    const { entryId } = req.params as any;
    const { content } = (req.body as any) || {};
    if (!content?.trim()) {
      return reply.status(400).send({ success: false, message: 'content is required' });
    }
    try {
      const result = await contestModel.addComment(entryId, req.user.membership_no, req.user.mobile!, content.trim());
      return reply.status(201).send({ success: true, comment: result.rows[0] });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to add comment' });
    }
  });
}
