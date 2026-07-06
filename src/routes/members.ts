import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import pool from '../config/db';
import * as memberModel from '../models/memberModel';
import { decrypt } from '../utils/encryption';

export default async function membersRoutes(fastify: FastifyInstance) {
  // All members routes require portal authentication
  fastify.addHook('preHandler', fastify.authenticate);

  // ── GET /api/portal/members ──
  // Paginated list of members with filters (search, district, taluka, panchayat, gender)
  // Include is_subscribed flag via a SQL EXISTS check on portal_subscriptions table.
  fastify.get('/members', async (req: FastifyRequest, reply: FastifyReply) => {
    const {
      page = '1',
      limit = '20',
      search,
      district,
      taluka,
      panchayat,
      gender,
    } = req.query as any;

    const pPage = parseInt(page, 10);
    const pLimit = parseInt(limit, 10);
    const offset = (pPage - 1) * pLimit;
    const currentMemberId = req.user.membership_no;

    try {
      const params: any[] = [currentMemberId];
      const conditions: string[] = [];

      if (search) {
        params.push(`%${search}%`);
        const idx = params.length;
        conditions.push(`(LOWER(m.name) LIKE LOWER($${idx}) OR m.mobile LIKE $${idx} OR m.membership_no LIKE $${idx})`);
      }
      if (district) {
        params.push(district);
        conditions.push(`m.district = $${params.length}`);
      }
      if (taluka) {
        params.push(taluka);
        conditions.push(`m.taluka = $${params.length}`);
      }
      if (panchayat) {
        params.push(panchayat);
        conditions.push(`m.panchayat = $${params.length}`);
      }
      if (gender === 'female') {
        conditions.push(`LOWER(m.head_gender) IN ('female', 'f')`);
      } else if (gender === 'male') {
        conditions.push(`LOWER(m.head_gender) NOT IN ('female', 'f')`);
      }

      const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Count query
      const countParams = params.slice(1);
      const countRes = await pool.query(
        `SELECT COUNT(*) FROM members m ${wherePart}`,
        countParams
      );
      const total = parseInt(countRes.rows[0].count, 10);
      const totalPages = Math.ceil(total / pLimit);

      // List query
      params.push(pLimit, offset);
      const query = `
        SELECT m.*,
               EXISTS (
                 SELECT 1 FROM portal_subscriptions
                 WHERE follower_id = $1 AND following_id = m.membership_no
               ) AS is_subscribed
        FROM members m
        ${wherePart}
        ORDER BY m.district, m.taluka, m.panchayat, m.name
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `;

      const res = await pool.query(query, params);

      // Decrypt Aadhar number if present
      res.rows.forEach(r => {
        if (r.aadhar_no) {
          try {
            r.aadhar_no = decrypt(r.aadhar_no);
          } catch {
            // ignore
          }
        }
      });

      return reply.send({
        success: true,
        members: res.rows,
        page: pPage,
        total,
        totalPages,
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch members' });
    }
  });

  // ── GET /api/portal/members/filters ──
  // Return distinct districts, talukas, panchayats
  fastify.get('/members/filters', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const filters = await memberModel.getMemberFilterOptions();
      return reply.send({
        success: true,
        filters,
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch filters' });
    }
  });

  // ── GET /api/portal/members/:id ──
  // Return single member's profile
  fastify.get('/members/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const member = await memberModel.getOne(id);
      if (!member) {
        return reply.status(404).send({ success: false, message: 'Member not found' });
      }
      return reply.send({
        success: true,
        member,
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch member profile' });
    }
  });

  // ── GET /api/portal/members/public/:id ──
  // Return public profile matching mobile expectations
  fastify.get('/members/public/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const currentMemberId = req.user.membership_no;

    try {
      const member = await memberModel.getOne(id);
      if (!member) {
        return reply.status(404).send({ success: false, message: 'Member profile not found' });
      }

      // Check if current user is following
      const followRes = await pool.query(
        'SELECT 1 FROM portal_subscriptions WHERE follower_id = $1 AND following_id = $2',
        [currentMemberId, id]
      );
      const isFollowing = followRes.rows.length > 0;

      // Stats
      const postsCountRes = await pool.query('SELECT COUNT(*) FROM portal_posts WHERE author_id = $1', [id]);
      const followersRes = await pool.query('SELECT COUNT(*) FROM portal_subscriptions WHERE following_id = $1', [id]);
      const followingRes = await pool.query('SELECT COUNT(*) FROM portal_subscriptions WHERE follower_id = $1', [id]);

      const familyArray = Array.isArray(member.family_members)
        ? member.family_members
        : JSON.parse(member.family_members || '[]');

      const stats = {
        posts: parseInt(postsCountRes.rows[0].count, 10),
        followers: parseInt(followersRes.rows[0].count, 10),
        following: parseInt(followingRes.rows[0].count, 10),
        familyMembers: familyArray.length,
      };

      // Family list
      const family = familyArray.map((fm: any) => ({
        name: fm.name,
        relation: fm.relation,
        gender: fm.gender,
        avatar: fm.profile_photo_url || null,
        isHoF: fm.relation === 'Self/Head' || fm.relation === 'Head'
      }));

      // Member posts
      const postsRes = await pool.query(
        `SELECT p.*,
                EXISTS(
                  SELECT 1 FROM portal_likes
                  WHERE post_id = p.id AND member_id = $2
                ) AS liked_by_me
         FROM portal_posts p
         WHERE p.author_id = $1
         ORDER BY p.created_at DESC`,
        [id, currentMemberId]
      );

      const posts = postsRes.rows.map(p => ({
        ...p,
        author_name: member.name,
        author_photo: member.profile_photo_url || null,
        media: (p.images || []).map((url: string) => ({ url, type: 'image' })),
      }));

      const profile = {
        id: member.membership_no,
        name: member.name,
        avatar: member.profile_photo_url || null,
        gender: member.head_gender,
        relation: 'Head',
        isHoF: true,
        village: member.village,
        district: member.district,
        joined: member.created_at ? new Date(member.created_at).getFullYear().toString() : '2026',
        isFollowing,
        stats,
        family,
        posts,
      };

      return reply.send({
        success: true,
        profile,
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch public profile' });
    }
  });

  // ── POST /api/portal/subscribe/:memberId ──
  // Toggle subscription (follow/unfollow) in portal_subscriptions
  fastify.post('/subscribe/:memberId', async (req: FastifyRequest, reply: FastifyReply) => {
    const followerId = req.user.membership_no;
    const { memberId } = req.params as any;

    if (followerId === memberId) {
      return reply.status(400).send({ success: false, message: 'You cannot follow yourself' });
    }

    try {
      // Check if target member exists
      const targetMember = await pool.query('SELECT mobile, name FROM members WHERE membership_no = $1', [memberId]);
      if (targetMember.rows.length === 0) {
        return reply.status(404).send({ success: false, message: 'Member not found' });
      }
      const followingMobile = targetMember.rows[0].mobile || '';

      // Check current user mobile
      const currentUser = await pool.query('SELECT mobile FROM members WHERE membership_no = $1', [followerId]);
      const followerMobile = currentUser.rows[0]?.mobile || '';

      // Check existing subscription
      const existing = await pool.query(
        'SELECT id FROM portal_subscriptions WHERE follower_id = $1 AND following_id = $2',
        [followerId, memberId]
      );

      let subscribed = false;
      if (existing.rows.length > 0) {
        // Unfollow
        await pool.query(
          'DELETE FROM portal_subscriptions WHERE follower_id = $1 AND following_id = $2',
          [followerId, memberId]
        );
        subscribed = false;
      } else {
        // Follow
        await pool.query(
          `INSERT INTO portal_subscriptions (follower_id, following_id, follower_mobile, following_mobile, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [followerId, memberId, followerMobile, followingMobile]
        );
        subscribed = true;
      }

      return reply.send({
        success: true,
        subscribed,
        message: subscribed ? 'Followed successfully' : 'Unfollowed successfully',
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update subscription' });
    }
  });
}
