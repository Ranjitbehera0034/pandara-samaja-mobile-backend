import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as contestModel from '../models/songContestModel';
import { verifyAdmin } from '../middleware/adminAuth';
import { logActivity } from '../utils/activityLog';
import { broadcastPushToAllMembers, sendPushToPerson } from '../utils/pushNotifications';

// Admin-gated Song Competition: create/start/close a contest, review
// entries. See backend ARCHITECTURE.md's "Song Competition" section.
export default async function adminSongContestRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyAdmin);

  // ── GET /api/admin/song-contests ── every contest, any status
  fastify.get('/song-contests', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await contestModel.listContests();
      return reply.send({ success: true, contests: result.rows });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch contests' });
    }
  });

  // ── POST /api/admin/song-contests ── created as a draft
  fastify.post('/song-contests', async (req: FastifyRequest, reply: FastifyReply) => {
    const { title, description, rules } = (req.body as any) || {};
    if (!title?.trim()) {
      return reply.status(400).send({ success: false, message: 'title is required' });
    }
    try {
      const result = await contestModel.createContest({
        title: title.trim(),
        description: description?.trim() || null,
        rules: rules?.trim() || null,
      });

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'song_contest_created',
        targetType: 'song_contest',
        targetId: String(result.rows[0].id),
        req,
      });

      return reply.status(201).send({ success: true, contest: result.rows[0] });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to create contest' });
    }
  });

  // ── PUT /api/admin/song-contests/:id ── only meaningful while still a draft
  fastify.put('/song-contests/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { title, description, rules } = (req.body as any) || {};
    try {
      const result = await contestModel.updateContest(id, {
        title: title?.trim(),
        description: description !== undefined ? (description?.trim() || null) : undefined,
        rules: rules !== undefined ? (rules?.trim() || null) : undefined,
      });
      if (!result.rows[0]) {
        return reply.status(404).send({ success: false, message: 'Contest not found' });
      }
      return reply.send({ success: true, contest: result.rows[0] });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update contest' });
    }
  });

  // ── POST /api/admin/song-contests/:id/start ── draft -> active, visible
  // to every member, who can then register. Broadcasts a push.
  fastify.post('/song-contests/:id/start', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await contestModel.startContest(id);
      const contest = result.rows[0];
      if (!contest) {
        return reply.status(400).send({ success: false, message: 'Contest not found or already started' });
      }

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'song_contest_started',
        targetType: 'song_contest',
        targetId: String(id),
        req,
      });

      broadcastPushToAllMembers(
        contest.title,
        'ନୂଆ ଗୀତ ପ୍ରତିଯୋଗିତା ଆରମ୍ଭ ହେଲା — ଏବେ ପଞ୍ଜୀକରଣ କରନ୍ତୁ',
        { type: 'song_contest_started', contestId: String(id) }
      ).catch(() => { /* never throws, defensive only */ });

      return reply.send({ success: true, contest });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to start contest' });
    }
  });

  // ── POST /api/admin/song-contests/:id/close ── active -> closed
  fastify.post('/song-contests/:id/close', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await contestModel.closeContest(id);
      if (!result.rows[0]) {
        return reply.status(400).send({ success: false, message: 'Contest not found or not active' });
      }

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'song_contest_closed',
        targetType: 'song_contest',
        targetId: String(id),
        req,
      });

      return reply.send({ success: true, contest: result.rows[0] });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to close contest' });
    }
  });

  // ── DELETE /api/admin/song-contests/:id ── cascades to entries/likes/comments
  fastify.delete('/song-contests/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await contestModel.deleteContest(id);
      if (!result.rows[0]) {
        return reply.status(404).send({ success: false, message: 'Contest not found' });
      }

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'song_contest_deleted',
        targetType: 'song_contest',
        targetId: String(id),
        req,
      });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to delete contest' });
    }
  });

  /* ─────────────── ENTRY MODERATION ────────────── */

  // ── GET /api/admin/song-contests/:id/entries?status=pending ──
  fastify.get('/song-contests/:id/entries', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { status } = req.query as any;
    try {
      const result = await contestModel.adminListEntries(id, status);
      return reply.send({ success: true, entries: result.rows });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch entries' });
    }
  });

  // ── POST /api/admin/song-contests/entries/:entryId/approve ──
  fastify.post('/song-contests/entries/:entryId/approve', async (req: FastifyRequest, reply: FastifyReply) => {
    const { entryId } = req.params as any;
    const admin = req.user as any;
    try {
      const result = await contestModel.approveEntry(entryId, admin.username);
      const entry = result.rows[0];
      if (!entry) {
        return reply.status(404).send({ success: false, message: 'Entry not found' });
      }

      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'song_contest_entry_approved',
        targetType: 'song_contest_entry',
        targetId: String(entryId),
        req,
      });

      sendPushToPerson(
        entry.registered_by_membership_no,
        entry.registered_by_mobile,
        'ଆପଣଙ୍କ ଏଣ୍ଟ୍ରି ଅନୁମୋଦିତ ହେଲା',
        `"${entry.entry_name}" ବର୍ତ୍ତମାନ ସମସ୍ତଙ୍କୁ ଦେଖାଯାଉଛି`,
        { type: 'song_contest_entry_approved', entryId: String(entryId) }
      ).catch(() => { /* never throws, defensive only */ });

      return reply.send({ success: true, entry });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to approve entry' });
    }
  });

  // ── POST /api/admin/song-contests/entries/:entryId/reject ── remark required
  fastify.post('/song-contests/entries/:entryId/reject', async (req: FastifyRequest, reply: FastifyReply) => {
    const { entryId } = req.params as any;
    const { remark } = (req.body as any) || {};
    if (!remark?.trim()) {
      return reply.status(400).send({ success: false, message: 'A remark is required' });
    }
    const admin = req.user as any;
    try {
      const result = await contestModel.rejectEntry(entryId, admin.username, remark.trim());
      const entry = result.rows[0];
      if (!entry) {
        return reply.status(404).send({ success: false, message: 'Entry not found' });
      }

      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'song_contest_entry_rejected',
        targetType: 'song_contest_entry',
        targetId: String(entryId),
        metadata: { remark: remark.trim() },
        req,
      });

      sendPushToPerson(
        entry.registered_by_membership_no,
        entry.registered_by_mobile,
        'ଆପଣଙ୍କ ଏଣ୍ଟ୍ରି ଗ୍ରହଣ ହେଲା ନାହିଁ',
        remark.trim(),
        { type: 'song_contest_entry_rejected', entryId: String(entryId) }
      ).catch(() => { /* never throws, defensive only */ });

      return reply.send({ success: true, entry });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to reject entry' });
    }
  });
}
