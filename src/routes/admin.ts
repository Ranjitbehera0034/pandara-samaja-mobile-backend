import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import UserModel from '../models/userModel';
import * as memberModel from '../models/memberModel';
import * as portalModel from '../models/portalModel';
import pool from '../config/db';
import { verifyAdmin } from '../middleware/adminAuth';
import { JWT_SECRET } from '../config/secrets';
import { logActivity } from '../utils/activityLog';
import { getSignedMediaUrl } from '../utils/firebaseStorage';
import { sendEmail } from '../utils/email';

export default async function adminRoutes(fastify: FastifyInstance) {
  // ── POST /api/admin/login ──
  fastify.post('/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { username, password } = req.body as any;
    if (!username || !password) {
      return reply.status(400).send({ success: false, message: 'Username and password are required' });
    }

    try {
      const user = await UserModel.findByUsername(username.trim());
      if (!user) {
        return reply.status(401).send({ success: false, message: 'Invalid username or password' });
      }

      const valid = await UserModel.verifyPassword(password, user.password_hash);
      if (!valid) {
        return reply.status(401).send({ success: false, message: 'Invalid username or password' });
      }

      // Reject login for disabled accounts. 42703-safe: `is_active` is
      // added by migrations/002_admin_dashboard_expansion.sql — if the
      // column doesn't exist yet, just let login proceed.
      try {
        const activeCheck = await pool.query('SELECT is_active FROM users WHERE id = $1', [user.id]);
        if (activeCheck.rows[0] && activeCheck.rows[0].is_active === false) {
          return reply.status(403).send({ success: false, message: 'This account has been disabled' });
        }
      } catch (err: any) {
        if (err.code !== '42703') throw err;
        // is_active column not migrated yet — allow login to proceed.
      }

      await UserModel.updateLastLogin(user.id);

      const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role, type: 'admin' },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      await logActivity({
        actorType: user.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(user.id),
        action: 'admin_login',
        req,
      });

      return reply.send({
        success: true,
        token,
        user: { id: user.id, username: user.username, role: user.role },
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Internal server error' });
    }
  });

  // ── GET /api/admin/me ──
  fastify.get('/me', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = await UserModel.findById((req.user as any).id);
      if (!user) return reply.status(404).send({ success: false, message: 'User not found' });
      return reply.send({ success: true, user: { id: user.id, username: user.username, role: user.role } });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Internal server error' });
    }
  });

  // ── POST /api/admin/users ── (superadmin only — create additional admin/superadmin accounts)
  fastify.post('/users', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    if ((req.user as any).role !== 'superadmin') {
      return reply.status(403).send({ success: false, message: 'Only super admins can create admin accounts' });
    }
    const { username, password, role, email } = req.body as any;
    if (!username || !password) {
      return reply.status(400).send({ success: false, message: 'Username and password are required' });
    }
    if (!['admin', 'superadmin'].includes(role)) {
      return reply.status(400).send({ success: false, message: 'Role must be "admin" or "superadmin"' });
    }

    try {
      const created = await UserModel.create(username.trim(), password, role, email ? String(email).trim() : undefined);
      const actor = req.user as any;
      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: 'admin_created',
        targetType: 'admin',
        targetId: String(created.id),
        metadata: { role },
        req,
      });

      // Fire-and-forget welcome email — never let a send failure affect
      // the 201 response already going out below.
      if (created.email) {
        try {
          sendEmail(
            created.email,
            'Your Pandara Samaja admin account',
            `<h2>Welcome to Pandara Samaja</h2>
             <p>An ${created.role === 'superadmin' ? 'super admin' : 'admin'} account has been created for you.</p>
             <p><strong>Username:</strong> ${created.username}</p>
             <p>Please get your password from the super admin who created this account.</p>`
          );
        } catch (emailErr) {
          fastify.log.error(emailErr);
        }
      }

      return reply.status(201).send({ success: true, user: created });
    } catch (err: any) {
      return reply.status(400).send({ success: false, message: err.message || 'Failed to create user' });
    }
  });

  // ── DELETE /api/admin/users/:id ── (superadmin only — remove an admin account)
  fastify.delete('/users/:id', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    if ((req.user as any).role !== 'superadmin') {
      return reply.status(403).send({ success: false, message: 'Only super admins can remove admin accounts' });
    }
    const { id } = req.params as any;
    if (String(id) === String((req.user as any).id)) {
      return reply.status(400).send({ success: false, message: 'You cannot remove your own account' });
    }
    try {
      // Grab the account's details (including email) before it's deleted —
      // there's nothing left to look up afterward.
      const existing = await UserModel.findById(id);

      await UserModel.delete(id);
      const actor = req.user as any;
      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: 'admin_deleted',
        targetType: 'admin',
        targetId: String(id),
        req,
      });

      // Fire-and-forget access-revoked email — never let a send failure
      // affect the success response already going out below.
      if (existing?.email) {
        try {
          sendEmail(
            existing.email,
            'Your Pandara Samaja admin access has been removed',
            `<h2>Access Removed</h2>
             <p>Your ${existing.role === 'superadmin' ? 'super admin' : 'admin'} account (username: ${existing.username}) for Pandara Samaja has been removed.</p>
             <p>You will no longer be able to log in with these credentials.</p>`
          );
        } catch (emailErr) {
          fastify.log.error(emailErr);
        }
      }

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to remove admin account' });
    }
  });

  // ── PUT /api/admin/users/:id ── (superadmin only — edit username/role, optional password reset)
  fastify.put('/users/:id', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    if ((req.user as any).role !== 'superadmin') {
      return reply.status(403).send({ success: false, message: 'Only super admins can edit admin accounts' });
    }
    const { id } = req.params as any;
    const { username, role, password } = req.body as any;
    if (role !== undefined && !['admin', 'superadmin'].includes(role)) {
      return reply.status(400).send({ success: false, message: 'Role must be "admin" or "superadmin"' });
    }

    try {
      const existing = await UserModel.findById(id);
      if (!existing) return reply.status(404).send({ success: false, message: 'Admin account not found' });

      // Guard: don't let the last remaining superadmin get demoted away.
      if (role && role !== 'superadmin' && existing.role === 'superadmin') {
        const superadminCount = await UserModel.countByRole('superadmin');
        if (superadminCount <= 1) {
          return reply.status(400).send({ success: false, message: 'Cannot demote the last remaining superadmin' });
        }
      }

      const updated = await UserModel.update(id, {
        username: username !== undefined ? username.trim() : undefined,
        role,
      });
      if (password) {
        await UserModel.updatePassword(id, password);
      }
      return reply.send({ success: true, user: updated });
    } catch (err: any) {
      fastify.log.error(err);
      return reply.status(400).send({ success: false, message: err.message || 'Failed to update admin account' });
    }
  });

  // ── PUT /api/admin/users/:id/ban ── (superadmin only — enable/disable an admin account)
  fastify.put('/users/:id/ban', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    if ((req.user as any).role !== 'superadmin') {
      return reply.status(403).send({ success: false, message: 'Only super admins can change admin account status' });
    }
    const { id } = req.params as any;
    const { active } = req.body as any;
    if (typeof active !== 'boolean') {
      return reply.status(400).send({ success: false, message: '"active" boolean is required' });
    }
    try {
      const result = await UserModel.setActive(id, active);
      if (!result.ok) {
        return reply.status(503).send({ success: false, message: 'Run the pending migration first' });
      }
      if (!result.user) return reply.status(404).send({ success: false, message: 'Admin account not found' });

      const actor = req.user as any;
      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: active ? 'admin_unbanned' : 'admin_banned',
        targetType: 'admin',
        targetId: String(id),
        req,
      });

      return reply.send({ success: true, user: result.user });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update admin account status' });
    }
  });

  // ── PUT /api/admin/settings/password ── any logged-in admin/superadmin changes their own password
  fastify.put('/settings/password', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { currentPassword, newPassword } = req.body as any;
    if (!currentPassword || !newPassword) {
      return reply.status(400).send({ success: false, message: 'currentPassword and newPassword are required' });
    }
    if (String(newPassword).length < 6) {
      return reply.status(400).send({ success: false, message: 'newPassword must be at least 6 characters' });
    }
    try {
      const actor = req.user as any;
      const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [actor.id]);
      const row = userRes.rows[0];
      if (!row) return reply.status(404).send({ success: false, message: 'User not found' });

      const valid = await UserModel.verifyPassword(currentPassword, row.password_hash);
      if (!valid) return reply.status(401).send({ success: false, message: 'Current password is incorrect' });

      await UserModel.updatePassword(row.id, newPassword);
      return reply.send({ success: true, message: 'Password updated successfully' });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update password' });
    }
  });

  // ── GET /api/admin/users ── (superadmin only — list all admin accounts)
  fastify.get('/users', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    if ((req.user as any).role !== 'superadmin') {
      return reply.status(403).send({ success: false, message: 'Only super admins can view admin accounts' });
    }
    try {
      const users = await UserModel.findAll();
      return reply.send({ success: true, users });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch admin accounts' });
    }
  });

  // ════════════════════════════════════════════════
  //  MEMBER MANAGEMENT (admin + superadmin)
  // ════════════════════════════════════════════════

  // ── GET /api/admin/members ──
  fastify.get('/members', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { page = '1', limit = '20', search, district, taluka, panchayat, village, gender } = req.query as any;
    const pPage = parseInt(page, 10);
    const pLimit = Math.min(parseInt(limit, 10) || 20, 100);
    const offset = (pPage - 1) * pLimit;

    try {
      const filters = { search, district, taluka, panchayat, village, gender };
      const [result, total] = await Promise.all([
        memberModel.getFiltered(pLimit, offset, filters),
        memberModel.getFilteredCount(filters),
      ]);
      const members = await Promise.all(result.rows.map(async (r: any) => ({
        ...r,
        profile_photo_url: await getSignedMediaUrl(r.profile_photo_url),
      })));
      return reply.send({
        success: true,
        members,
        total,
        page: pPage,
        totalPages: Math.ceil(total / pLimit),
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch members' });
    }
  });

  // ── GET /api/admin/members/filters ── district/taluka/panchayat/village
  // options for the admin members filter modal (mirrors the member-facing
  // GET /portal/members/filters).
  fastify.get('/members/filters', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const filters = await memberModel.getMemberFilterOptions();
      return reply.send({ success: true, filters });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch filters' });
    }
  });

  // ── GET /api/admin/members/:id ── includes an activity summary so the
  // admin dashboard can show what a specific member has been doing, not
  // just their profile fields.
  fastify.get('/members/:id', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const member = await memberModel.getOne(id);
      if (!member) return reply.status(404).send({ success: false, message: 'Member not found' });

      member.profile_photo_url = await getSignedMediaUrl(member.profile_photo_url);
      // Family members' photos are either a Firebase-hosted path (needs
      // signing, same as the head's) or a raw base64 data URI (already
      // directly renderable) — getSignedMediaUrl passes data: URIs through
      // unchanged since they don't match its Firebase-path handling.
      const familyMembers = Array.isArray(member.family_members)
        ? member.family_members
        : (() => { try { return JSON.parse(member.family_members || '[]'); } catch { return []; } })();
      member.family_members = await Promise.all(
        familyMembers.map(async (fm: any) => ({
          ...fm,
          profile_pic: fm.profile_pic?.startsWith('data:') ? fm.profile_pic : await getSignedMediaUrl(fm.profile_pic),
        }))
      );

      const [postsRes, reportsAgainstRes, reportsFiledRes] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM portal_posts WHERE author_id = $1', [id]),
        pool.query(
          `SELECT COUNT(*) FROM portal_reports r
           JOIN portal_posts p ON p.id = r.post_id
           WHERE p.author_id = $1`,
          [id]
        ),
        pool.query('SELECT COUNT(*) FROM portal_reports WHERE reporter_id = $1', [id]),
      ]);

      return reply.send({
        success: true,
        member,
        activity: {
          postsCount: parseInt(postsRes.rows[0].count, 10),
          reportsAgainstCount: parseInt(reportsAgainstRes.rows[0].count, 10),
          reportsFiledCount: parseInt(reportsFiledRes.rows[0].count, 10),
        },
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch member' });
    }
  });

  // ── PUT /api/admin/members/:id ── edit non-sensitive member fields.
  // aadhar_no (encrypted, sensitive) and membership_no (primary identifier)
  // are intentionally NOT editable here. memberModel.update() does a
  // merge-with-existing update, so fields not present in this admin body
  // (family_members, profile_photo_url, male, female) are preserved as-is.
  fastify.put('/members/:id', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { name, mobile, district, taluka, panchayat, village, address, head_gender } = req.body as any;

    try {
      const data: Record<string, any> = {};
      if (name !== undefined) data.name = name;
      if (mobile !== undefined) data.mobile = mobile;
      if (district !== undefined) data.district = district;
      if (taluka !== undefined) data.taluka = taluka;
      if (panchayat !== undefined) data.panchayat = panchayat;
      if (village !== undefined) data.village = village;
      if (address !== undefined) data.address = address;
      if (head_gender !== undefined) data.head_gender = head_gender;

      const updated = await memberModel.update(id, data);
      if (!updated) return reply.status(404).send({ success: false, message: 'Member not found' });

      const actor = req.user as any;
      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: 'member_edited',
        targetType: 'member',
        targetId: String(id),
        req,
      });

      return reply.send({ success: true, member: updated });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update member' });
    }
  });

  // ── PUT /api/admin/members/:id/ban ──
  fastify.put('/members/:id/ban', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { banned } = req.body as any;
    try {
      const updated = await memberModel.setBanned(id, !!banned);
      if (!updated) return reply.status(404).send({ success: false, message: 'Member not found' });

      const actor = req.user as any;
      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: banned ? 'member_banned' : 'member_unbanned',
        targetType: 'member',
        targetId: String(id),
        req,
      });

      return reply.send({ success: true, member: updated });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update member status' });
    }
  });

  // ── GET /api/admin/members/demographics ── community-wide demographics
  // computed from every household's family_members roster (per-person
  // age/marital-status breakdowns, not the dead household-level male/female
  // integer columns).
  fastify.get('/members/demographics', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const demographics = await memberModel.getDemographics();
      return reply.send({ success: true, demographics });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch demographics' });
    }
  });

  // ── GET /api/admin/members/:id/family ── a member's household roster
  fastify.get('/members/:id/family', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const familyMembers = await memberModel.getFamilyMembers(id);
      if (familyMembers === null) {
        return reply.status(404).send({ success: false, message: 'Member not found' });
      }
      return reply.send({ success: true, familyMembers });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch family members' });
    }
  });

  // ── POST /api/admin/members/:id/family ── add a person to a member's household
  fastify.post('/members/:id/family', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { name, relation, gender, age, marital_status, mobile } = req.body as any;
    if (!name || !relation) {
      return reply.status(400).send({ success: false, message: 'name and relation are required' });
    }
    try {
      const familyMembers = await memberModel.addFamilyMember(id, { name, relation, gender, age, marital_status, mobile });
      if (familyMembers === null) {
        return reply.status(404).send({ success: false, message: 'Member not found' });
      }

      const actor = req.user as any;
      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: 'admin_family_member_added',
        targetType: 'member',
        targetId: String(id),
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

  // ── PUT /api/admin/members/:id/family/:index ── edit a person in a member's household
  fastify.put('/members/:id/family/:index', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id, index } = req.params as any;
    const { name, relation, gender, age, marital_status, mobile } = req.body as any;
    const idx = parseInt(index, 10);
    if (isNaN(idx)) {
      return reply.status(400).send({ success: false, message: 'index must be a number' });
    }
    try {
      const familyMembers = await memberModel.updateFamilyMember(id, idx, { name, relation, gender, age, marital_status, mobile });
      if (familyMembers === null) {
        return reply.status(404).send({ success: false, message: 'Member or family member index not found' });
      }

      const actor = req.user as any;
      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: 'admin_family_member_updated',
        targetType: 'member',
        targetId: String(id),
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

  // ── DELETE /api/admin/members/:id/family/:index ── remove a person from a member's household
  fastify.delete('/members/:id/family/:index', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id, index } = req.params as any;
    const idx = parseInt(index, 10);
    if (isNaN(idx)) {
      return reply.status(400).send({ success: false, message: 'index must be a number' });
    }
    try {
      const familyMembers = await memberModel.removeFamilyMember(id, idx);
      if (familyMembers === null) {
        return reply.status(404).send({ success: false, message: 'Member or family member index not found' });
      }

      const actor = req.user as any;
      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: 'admin_family_member_removed',
        targetType: 'member',
        targetId: String(id),
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

  // ════════════════════════════════════════════════
  //  CONTENT MODERATION (admin + superadmin)
  //  Reported posts are auto-hidden the moment they're reported (see
  //  portalModel.reportPost) and stay invisible to everyone until an
  //  admin/superadmin reviews them here.
  // ════════════════════════════════════════════════

  // ── GET /api/admin/reports ── posts currently hidden pending review
  fastify.get('/reports', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const posts = await portalModel.getReportedPosts();
      return reply.send({ success: true, posts });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch reported posts' });
    }
  });

  // ── POST /api/admin/reports/:postId/approve ── restores the post (report was unfounded)
  fastify.post('/reports/:postId/approve', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { postId } = req.params as any;
    try {
      const result = await portalModel.approvePost(postId);
      if (!result) return reply.status(404).send({ success: false, message: 'Post not found' });

      const actor = req.user as any;
      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: 'report_approved',
        targetType: 'post',
        targetId: String(postId),
        req,
      });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to approve post' });
    }
  });

  // ── POST /api/admin/reports/:postId/reject ── permanently deletes the post (report was valid)
  fastify.post('/reports/:postId/reject', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { postId } = req.params as any;
    try {
      const result = await portalModel.rejectPost(postId);
      if (!result) return reply.status(404).send({ success: false, message: 'Post not found' });

      const actor = req.user as any;
      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: 'report_rejected',
        targetType: 'post',
        targetId: String(postId),
        req,
      });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to reject post' });
    }
  });

  // ── GET /api/admin/story-reports ── stories currently hidden pending review
  fastify.get('/story-reports', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const rows = await portalModel.getReportedStories();
      const stories = await Promise.all(rows.map(async (row: any) => ({
        id: row.id.toString(),
        authorId: row.author_id,
        authorName: row.author_name,
        authorAvatar: await getSignedMediaUrl(row.author_avatar),
        mediaUrl: await getSignedMediaUrl(row.media_url),
        mediaType: row.media_type,
        textOverlay: row.text_overlay,
        createdAt: row.created_at,
        reports: row.reports,
      })));
      return reply.send({ success: true, stories });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch reported stories' });
    }
  });

  // ── POST /api/admin/story-reports/:storyId/approve ── restores the story (report was unfounded)
  fastify.post('/story-reports/:storyId/approve', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { storyId } = req.params as any;
    try {
      const result = await portalModel.approveStory(storyId);
      if (!result) return reply.status(404).send({ success: false, message: 'Story not found' });

      const actor = req.user as any;
      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: 'story_report_approved',
        targetType: 'story',
        targetId: String(storyId),
        req,
      });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to approve story' });
    }
  });

  // ── POST /api/admin/story-reports/:storyId/reject ── permanently deletes the story (report was valid)
  fastify.post('/story-reports/:storyId/reject', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { storyId } = req.params as any;
    try {
      const result = await portalModel.rejectStory(storyId);
      if (!result) return reply.status(404).send({ success: false, message: 'Story not found' });

      const actor = req.user as any;
      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: 'story_report_rejected',
        targetType: 'story',
        targetId: String(storyId),
        req,
      });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to reject story' });
    }
  });

  // ── DELETE /api/admin/stories/:storyId ── admin/superadmin can delete any story directly,
  // without requiring a prior report (moderation power, not tied to the report queue).
  fastify.delete('/stories/:storyId', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { storyId } = req.params as any;
    try {
      const result = await portalModel.rejectStory(storyId);
      if (!result) return reply.status(404).send({ success: false, message: 'Story not found' });

      const actor = req.user as any;
      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: 'story_deleted_by_admin',
        targetType: 'story',
        targetId: String(storyId),
        req,
      });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to delete story' });
    }
  });
}
