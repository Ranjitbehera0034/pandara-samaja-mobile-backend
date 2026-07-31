import pool from '../config/db';
import { decrypt } from '../utils/encryption';
import { getSignedMediaUrl, resolveMediaUrls } from '../utils/firebaseStorage';
import bcrypt from 'bcryptjs';

// Shapes a raw `members` row for sending to the client: drops sensitive
// fields, normalizes family_members to a real array (it may come back from
// Postgres as a JSON string depending on column type), and resolves the
// profile photo to a loadable URL. Used anywhere a full member object is
// sent to the app (login, /me) instead of a hand-picked field whitelist —
// a previous whitelist silently dropped family_members/head_gender, which
// broke every screen that reads a member's own family data.
export const sanitizeMemberForClient = async (member: any) => {
  if (!member) return member;
  const { aadhar_no, ...rest } = member;
  const familyMembers = Array.isArray(rest.family_members)
    ? rest.family_members
    : (() => { try { return JSON.parse(rest.family_members || '[]'); } catch { return []; } })();
  return {
    ...rest,
    family_members: familyMembers,
    profile_photo_url: await getSignedMediaUrl(rest.profile_photo_url),
  };
};

// Find member by credentials (membership_no + mobile)
export const findByCredentials = async (membershipNo: string, mobile: string) => {
  const memberRes = await pool.query(
    'SELECT * FROM members WHERE membership_no = $1',
    [membershipNo]
  );
  const member = memberRes.rows[0];
  if (!member) return null;

  // Decrypt Aadhar number if exists
  if (member.aadhar_no) {
    member.aadhar_no = decrypt(member.aadhar_no);
  }

  // Check mobile matches member or any family member
  const cleanMobile = mobile.replace(/\D/g, '').slice(-10);
  if (!cleanMobile) return null;

  const memberMobile = (member.mobile || '').replace(/\D/g, '').slice(-10);
  // `null` familyIndex means "this is the head of family, identified by the
  // members row itself" — a real 0-based index means "this specific family
  // member". Every write path (posts, comments, likes, profile photo)
  // downstream needs this to attribute the action to the right individual
  // instead of always defaulting to the household head.
  let matchedUser: { name: string; relation: string; mobile: string; profile_photo_url: string | null; gender: string | null; familyIndex: number | null } | null = null;

  if (memberMobile === cleanMobile) {
    matchedUser = {
      name: member.name,
      relation: 'Self/Head',
      mobile: member.mobile || '',
      profile_photo_url: member.profile_photo_url || null,
      gender: member.head_gender || null,
      familyIndex: null,
    };
  } else {
    // Check family members. NOTE: the real JSONB field for a family
    // member's own photo is `profile_pic` (confirmed against production
    // data), not `profile_photo_url` — an earlier version of this function
    // read the wrong field name and always got `null` for every family
    // member's photo regardless of what was actually on file.
    const familyMembers = Array.isArray(member.family_members)
      ? member.family_members
      : JSON.parse(member.family_members || '[]');

    for (let i = 0; i < familyMembers.length; i++) {
      const fm = familyMembers[i];
      const fmMobile = (fm.mobile || '').replace(/\D/g, '').slice(-10);
      if (fmMobile && fmMobile === cleanMobile) {
        matchedUser = {
          name: fm.name,
          relation: fm.relation,
          mobile: fm.mobile || '',
          profile_photo_url: fm.profile_pic || null,
          gender: fm.gender || null,
          familyIndex: i,
        };
        break;
      }
    }
  }

  if (!matchedUser) return null;

  // Update last portal login
  await pool.query(
    'UPDATE members SET last_portal_login = CURRENT_TIMESTAMP WHERE membership_no = $1',
    [membershipNo]
  );

  return { member, matchedUser };
};


// Get member portal profile
export const getMemberProfile = async (membershipNo: string) => {
  const res = await pool.query(
    'SELECT * FROM members WHERE membership_no = $1',
    [membershipNo]
  );
  const member = res.rows[0];
  if (!member) return null;
  if (member.aadhar_no) {
    member.aadhar_no = decrypt(member.aadhar_no);
  }
  member.profile_photo_url = await getSignedMediaUrl(member.profile_photo_url);
  return member;
};

// Get logged user profile (portal_users table if it exists)
export const getLoggedUserProfile = async (membershipNo: string) => {
  try {
    const res = await pool.query(
      'SELECT * FROM portal_users WHERE membership_no = $1 LIMIT 1',
      [membershipNo]
    );
    return res.rows[0] || null;
  } catch {
    return null;
  }
};

// ── OTP: Save bcrypt-hashed OTP with 5-minute expiry ──
// Table: portal_otps (membership_no, mobile, otp_code, expires_at)
// Note: web backend uses portal_otps table, NOT otp_verification
export const saveOtp = async (membershipNo: string, mobile: string, otp: string) => {
  const otpHash = await bcrypt.hash(otp, 10);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await pool.query(
    `INSERT INTO portal_otps (membership_no, mobile, otp_code, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [membershipNo, mobile, otpHash, expiresAt]
  );
};

// ── OTP: Verify OTP code using bcrypt ──
export const verifyOtpCode = async (
  membershipNo: string, mobile: string, otp: string
): Promise<boolean> => {
  const res = await pool.query(
    `SELECT id, otp_code, expires_at FROM portal_otps
     WHERE membership_no = $1 AND mobile = $2
     ORDER BY created_at DESC LIMIT 1`,
    [membershipNo, mobile]
  );
  const record = res.rows[0];
  if (!record) return false;
  if (new Date() > record.expires_at) return false;

  const isMatch = await bcrypt.compare(otp, record.otp_code);
  if (!isMatch) return false;

  // Delete used OTP
  await pool.query(`DELETE FROM portal_otps WHERE id = $1`, [record.id]);
  return true;
};

// ═══════════════════════════════════════════════════
//  COMMUNITY POSTS (FEED)
// ═══════════════════════════════════════════════════

/**
 * Create a new community post
 * Table: portal_posts (author_id, text_content, images, location, author_name)
 */
export const createPost = async ({
  authorId,
  textContent,
  images,
  location,
  authorName,
  authorPhoto,
  authorMobile,
}: {
  authorId: string;
  textContent?: string;
  images?: string[];
  location?: string;
  authorName?: string;
  authorPhoto?: string | null;
  authorMobile?: string | null;
}) => {
  const res = await pool.query(
    `INSERT INTO portal_posts (author_id, text_content, images, location, author_name, author_photo, author_mobile)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [authorId, textContent || null, images || [], location || null, authorName || null, authorPhoto || null, authorMobile || null]
  );
  return res.rows[0];
};

/**
 * Get all posts (paginated) with author info and like counts
 * Matches web backend portalModel.getPosts exactly
 */
export const getPosts = async ({
  page = 1,
  limit = 20,
  membershipNo = '',
}: {
  page?: number;
  limit?: number;
  membershipNo?: string;
}) => {
  const offset = (page - 1) * limit;
  const baseSelect = `SELECT p.*,
        COALESCE(p.author_name, m.name) AS author_name,
        m.village AS author_village,
        m.district AS author_district,
        COALESCE(p.author_photo, m.profile_photo_url) AS author_photo,
        EXISTS(
          SELECT 1 FROM portal_likes l
          WHERE l.post_id = p.id AND l.member_id = $3
        ) AS liked_by_me
     FROM portal_posts p
     JOIN members m ON m.membership_no = p.author_id`;

  let res;
  try {
    // moderation_status requires a migration (see ALTER TABLE noted in
    // recent commits) that may not have run yet on every environment.
    // Fall back to the unfiltered query below rather than let a missing
    // column take down the entire feed for every user.
    res = await pool.query(
      `${baseSelect}
       WHERE p.moderation_status IS NULL OR p.moderation_status = 'visible'
       ORDER BY p.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset, membershipNo]
    );
  } catch (err: any) {
    if (err.code !== '42703') throw err; // 42703 = undefined_column
    console.warn('[getPosts] portal_posts.moderation_status column missing — serving unfiltered feed until the migration runs.');
    res = await pool.query(
      `${baseSelect}
       ORDER BY p.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset, membershipNo]
    );
  }

  return Promise.all(res.rows.map(async (row) => ({
    ...row,
    images: await resolveMediaUrls(row.images),
    author_photo: await getSignedMediaUrl(row.author_photo),
  })));
};

/**
 * Get single post with author data
 */
export const getPost = async (postId: string, membershipNo: string) => {
  const res = await pool.query(
    `SELECT p.*,
        COALESCE(p.author_name, m.name) AS author_name,
        COALESCE(p.author_photo, m.profile_photo_url) AS author_photo,
        EXISTS(
          SELECT 1 FROM portal_likes l
          WHERE l.post_id = p.id AND l.member_id = $2
        ) AS liked_by_me
     FROM portal_posts p
     JOIN members m ON m.membership_no = p.author_id
     WHERE p.id = $1`,
    [postId, membershipNo]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    ...row,
    images: await resolveMediaUrls(row.images),
    author_photo: await getSignedMediaUrl(row.author_photo),
  };
};

/**
 * Delete a post — only by the author
 */
export const deletePost = async (postId: string, authorId: string) => {
  const res = await pool.query(
    `DELETE FROM portal_posts WHERE id = $1 AND author_id = $2 RETURNING id`,
    [postId, authorId]
  );
  return res.rows[0] || null;
};

/**
 * Edit a post — only by the author
 */
export const editPost = async (postId: string, authorId: string, newText: string) => {
  const res = await pool.query(
    `UPDATE portal_posts SET text_content = $1, updated_at = NOW()
     WHERE id = $2 AND author_id = $3
     RETURNING *`,
    [newText, postId, authorId]
  );
  return res.rows[0] || null;
};

/**
 * Report a post
 */
export const reportPost = async (postId: string, reporterId: string, reason: string) => {
  const res = await pool.query(
    `INSERT INTO portal_reports (post_id, reporter_id, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (post_id, reporter_id) DO UPDATE SET reason = $3, created_at = NOW()
     RETURNING *`,
    [postId, reporterId, reason]
  );
  // Auto-hide immediately on report — a human (admin/superadmin) has to
  // review and explicitly restore it before it's visible again. If the
  // migration for this column hasn't run yet, the report is still recorded
  // above; just log instead of failing the whole request.
  try {
    await pool.query(
      `UPDATE portal_posts SET moderation_status = 'hidden_pending_review' WHERE id = $1`,
      [postId]
    );
  } catch (err: any) {
    if (err.code !== '42703') throw err;
    console.warn('[reportPost] portal_posts.moderation_status column missing — report recorded but post was not auto-hidden.');
  }
  return res.rows[0];
};

// ═══════════════════════════════════════════════════
//  CONTENT MODERATION (admin/superadmin)
// ═══════════════════════════════════════════════════

export const getReportedPosts = async () => {
  const res = await pool.query(
    `SELECT p.*,
            COALESCE(p.author_name, m.name) AS author_name,
            COALESCE(p.author_photo, m.profile_photo_url) AS author_photo,
            COALESCE(
              json_agg(
                json_build_object('reporter_id', r.reporter_id, 'reason', r.reason, 'created_at', r.created_at)
              ) FILTER (WHERE r.id IS NOT NULL), '[]'
            ) AS reports
     FROM portal_posts p
     JOIN members m ON m.membership_no = p.author_id
     LEFT JOIN portal_reports r ON r.post_id = p.id
     WHERE p.moderation_status = 'hidden_pending_review'
     GROUP BY p.id, m.name, m.profile_photo_url
     ORDER BY p.created_at DESC`
  );
  return res.rows;
};

export const approvePost = async (postId: string) => {
  const res = await pool.query(
    `UPDATE portal_posts SET moderation_status = 'visible' WHERE id = $1 RETURNING id`,
    [postId]
  );
  if (res.rows[0]) {
    await pool.query('DELETE FROM portal_reports WHERE post_id = $1', [postId]);
  }
  return res.rows[0] || null;
};

export const rejectPost = async (postId: string) => {
  // Permanent deletion, as requested — a rejected report means the content
  // stays gone, not just re-hidden.
  const res = await pool.query('DELETE FROM portal_posts WHERE id = $1 RETURNING id', [postId]);
  if (res.rows[0]) {
    await pool.query('DELETE FROM portal_reports WHERE post_id = $1', [postId]);
  }
  return res.rows[0] || null;
};

// Alias for the admin "permanently delete a post" action — rejectPost
// already performs a full delete (post + any reports against it); exposed
// under a clearer name here instead of duplicating the logic.
export const deletePostPermanently = rejectPost;

// ═══════════════════════════════════════════════════
//  ADMIN: FEED/POST MANAGEMENT (any moderation_status)
// ═══════════════════════════════════════════════════

export const getPostsAdmin = async ({
  page = 1,
  limit = 20,
  search = '',
}: {
  page?: number;
  limit?: number;
  search?: string;
}) => {
  const offset = (page - 1) * limit;
  const params: any[] = [];
  const conditions: string[] = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(LOWER(p.text_content) LIKE LOWER($${params.length}) OR LOWER(COALESCE(p.author_name, m.name)) LIKE LOWER($${params.length}))`);
  }
  const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  const res = await pool.query(
    `SELECT p.*,
        COALESCE(p.author_name, m.name) AS author_name,
        COALESCE(p.author_photo, m.profile_photo_url) AS author_photo
     FROM portal_posts p
     JOIN members m ON m.membership_no = p.author_id
     ${wherePart}
     ORDER BY p.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return Promise.all(res.rows.map(async (row) => ({
    ...row,
    images: await resolveMediaUrls(row.images),
    author_photo: await getSignedMediaUrl(row.author_photo),
  })));
};

export const getPostsAdminCount = async (search = ''): Promise<number> => {
  const params: any[] = [];
  let wherePart = '';
  if (search) {
    params.push(`%${search}%`);
    wherePart = `WHERE (LOWER(p.text_content) LIKE LOWER($1) OR LOWER(COALESCE(p.author_name, m.name)) LIKE LOWER($1))`;
  }
  const res = await pool.query(
    `SELECT COUNT(*) FROM portal_posts p JOIN members m ON m.membership_no = p.author_id ${wherePart}`,
    params
  );
  return parseInt(res.rows[0].count, 10);
};

// Toggle a post's visibility without needing an actual report filed
// against it. 42703-safe: moderation_status is the same column guarded
// elsewhere in this file (see getPosts/reportPost).
export const setPostHidden = async (
  postId: string,
  hidden: boolean
): Promise<{ ok: boolean; row: any | null }> => {
  try {
    const res = await pool.query(
      `UPDATE portal_posts SET moderation_status = $1 WHERE id = $2 RETURNING id, moderation_status`,
      [hidden ? 'hidden_pending_review' : 'visible', postId]
    );
    return { ok: true, row: res.rows[0] || null };
  } catch (err: any) {
    if (err.code !== '42703') throw err;
    console.warn('[setPostHidden] portal_posts.moderation_status column missing — cannot hide/unhide post until the migration runs.');
    return { ok: false, row: null };
  }
};

/**
 * Increment share count
 */
export const sharePost = async (postId: string) => {
  const res = await pool.query(
    `UPDATE portal_posts
     SET share_count = COALESCE(share_count, 0) + 1
     WHERE id = $1
     RETURNING id, share_count`,
    [postId]
  );
  return res.rows[0];
};

/**
 * Record a video view
 */
export const recordView = async (postId: string, memberId: string, durationSeconds: number) => {
  await pool.query(
    `UPDATE portal_posts
     SET views_count = COALESCE(views_count, 0) + 1
     WHERE id = $1`,
    [postId]
  );
  // Optional: insert into portal_views table if it exists
  try {
    await pool.query(
      `INSERT INTO portal_views (post_id, member_id, duration_seconds)
       VALUES ($1, $2, $3)
       ON CONFLICT (post_id, member_id) DO UPDATE SET duration_seconds = $3`,
      [postId, memberId, durationSeconds || 0]
    );
  } catch {
    // Table may not exist — ignore
  }
};

// ═══════════════════════════════════════════════════
//  LIKES
// ═══════════════════════════════════════════════════

/**
 * Toggle like on a post with row locking to prevent race conditions
 * Returns { liked: boolean, likes_count: number }
 * Matches web backend portalModel.toggleLike exactly
 */
export const toggleLike = async (postId: string, memberId: string, memberMobile: string) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the post row
    await client.query(
      `SELECT id FROM portal_posts WHERE id = $1 FOR UPDATE`,
      [postId]
    );

    // Check if already liked — keyed on (post_id, member_id, member_mobile)
    // so two different people sharing the same membership_no (household)
    // are tracked as independent likers, not collapsed into one.
    const existing = await client.query(
      `SELECT id FROM portal_likes WHERE post_id = $1 AND member_id = $2 AND member_mobile = $3`,
      [postId, memberId, memberMobile]
    );

    let liked: boolean;
    if (existing.rows.length > 0) {
      // Unlike
      await client.query(
        `DELETE FROM portal_likes WHERE post_id = $1 AND member_id = $2 AND member_mobile = $3`,
        [postId, memberId, memberMobile]
      );
      await client.query(
        `UPDATE portal_posts SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = $1`,
        [postId]
      );
      liked = false;
    } else {
      // Like
      await client.query(
        `INSERT INTO portal_likes (post_id, member_id, member_mobile) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [postId, memberId, memberMobile]
      );
      await client.query(
        `UPDATE portal_posts SET likes_count = likes_count + 1 WHERE id = $1`,
        [postId]
      );
      liked = true;
    }

    // Get updated count + author
    const countRes = await client.query(
      `SELECT likes_count, author_id FROM portal_posts WHERE id = $1`,
      [postId]
    );
    const likes_count = countRes.rows[0]?.likes_count || 0;
    const authorId = countRes.rows[0]?.author_id;

    // Create notification if liked (not by own author)
    if (liked && authorId && authorId !== memberId) {
      await client.query(
        `INSERT INTO portal_notifications (recipient_id, actor_id, type, post_id, message)
         VALUES ($1, $2, 'like', $3, $4)`,
        [authorId, memberId, postId, 'liked your post']
      );
    }

    await client.query('COMMIT');
    return { liked, likes_count };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

/**
 * Toggle like on a comment
 */
export const toggleCommentLike = async (commentId: string, memberId: string) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT id FROM portal_comment_likes WHERE comment_id = $1 AND member_id = $2`,
      [commentId, memberId]
    );

    let liked: boolean;
    if (existing.rows.length > 0) {
      await client.query(
        `DELETE FROM portal_comment_likes WHERE comment_id = $1 AND member_id = $2`,
        [commentId, memberId]
      );
      await client.query(
        `UPDATE portal_comments SET likes_count = GREATEST(COALESCE(likes_count,0) - 1, 0) WHERE id = $1`,
        [commentId]
      );
      liked = false;
    } else {
      await client.query(
        `INSERT INTO portal_comment_likes (comment_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [commentId, memberId]
      );
      await client.query(
        `UPDATE portal_comments SET likes_count = COALESCE(likes_count, 0) + 1 WHERE id = $1`,
        [commentId]
      );
      liked = true;
    }

    const res = await client.query(
      `SELECT likes_count FROM portal_comments WHERE id = $1`,
      [commentId]
    );

    await client.query('COMMIT');
    return { liked, likes_count: res.rows[0]?.likes_count || 0 };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════
//  COMMENTS
// ═══════════════════════════════════════════════════

/**
 * Add a comment (or reply) to a post
 * Increments post comments_count
 * Creates notification for post author
 */
export const addComment = async (
  postId: string,
  memberId: string,
  text: string,
  authorName: string,
  parentId?: string,
  authorPhoto?: string | null,
  authorMobile?: string | null
) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const res = await client.query(
      `INSERT INTO portal_comments (post_id, member_id, text, author_name, parent_id, author_photo, author_mobile)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [postId, memberId, text, authorName || null, parentId || null, authorPhoto || null, authorMobile || null]
    );

    await client.query(
      `UPDATE portal_posts SET comments_count = comments_count + 1 WHERE id = $1`,
      [postId]
    );

    // Fetch with author photo
    const commentWithAuthor = await client.query(
      `SELECT c.*, COALESCE(c.author_name, m.name) AS author_name, COALESCE(c.author_photo, m.profile_photo_url) AS author_photo
       FROM portal_comments c
       JOIN members m ON m.membership_no = c.member_id
       WHERE c.id = $1`,
      [res.rows[0].id]
    );

    // Notification
    const postRes = await client.query(
      `SELECT author_id FROM portal_posts WHERE id = $1`,
      [postId]
    );
    const postAuthorId = postRes.rows[0]?.author_id;
    if (postAuthorId && postAuthorId !== memberId) {
      const snippet = text.length > 30 ? text.substring(0, 30) + '...' : text;
      await client.query(
        `INSERT INTO portal_notifications (recipient_id, actor_id, type, post_id, message)
         VALUES ($1, $2, 'comment', $3, $4)`,
        [postAuthorId, memberId, postId, `commented: "${snippet}"`]
      );
    }

    await client.query('COMMIT');
    return commentWithAuthor.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

/**
 * Get paginated comments for a post
 */
export const getComments = async (postId: string, page = 1, limit = 5) => {
  const offset = (page - 1) * limit;

  const countRes = await pool.query(
    `SELECT COUNT(*) FROM portal_comments WHERE post_id = $1`,
    [postId]
  );
  const total = parseInt(countRes.rows[0].count, 10);

  const res = await pool.query(
    `SELECT c.*, COALESCE(c.author_name, m.name) AS author_name,
            COALESCE(c.author_photo, m.profile_photo_url) AS author_photo,
            COALESCE(c.likes_count, 0) AS likes_count
     FROM portal_comments c
     JOIN members m ON m.membership_no = c.member_id
     WHERE c.post_id = $1
     ORDER BY c.created_at ASC
     LIMIT $2 OFFSET $3`,
    [postId, limit, offset]
  );

  return { comments: res.rows, total };
};

/**
 * Delete a comment — only by author
 * Decrements post comments_count
 */
export const deleteComment = async (commentId: string, memberId: string) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const res = await client.query(
      `DELETE FROM portal_comments
       WHERE id = $1 AND member_id = $2
       RETURNING post_id`,
      [commentId, memberId]
    );

    if (res.rows[0]) {
      await client.query(
        `UPDATE portal_posts SET comments_count = GREATEST(comments_count - 1, 0)
         WHERE id = $1`,
        [res.rows[0].post_id]
      );
    }

    await client.query('COMMIT');
    return res.rows[0] || null;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

// ═══════════════════════════════════════════════════
//  NOTIFICATIONS (used by socket + feed routes)
// ═══════════════════════════════════════════════════

export const getUnreadNotificationCount = async (membershipNo: string): Promise<number> => {
  const res = await pool.query(
    `SELECT COUNT(*) FROM portal_notifications
     WHERE recipient_id = $1 AND read = false`,
    [membershipNo]
  );
  return parseInt(res.rows[0].count, 10);
};

export const createNotification = async (
  recipientId: string,
  type: string,
  actorId: string,
  message: string,
  postId?: string | null
) => {
  await pool.query(
    `INSERT INTO portal_notifications (recipient_id, actor_id, type, post_id, message)
     VALUES ($1, $2, $3, $4, $5)`,
    [recipientId, actorId, type, postId || null, message]
  );
};

export const getNotifications = async (
  membershipNo: string,
  limit = 20,
  offset = 0
): Promise<any[]> => {
  const res = await pool.query(
    `SELECT n.*, m.name AS actor_name, m.profile_photo_url AS actor_avatar
     FROM portal_notifications n
     JOIN members m ON m.membership_no = n.actor_id
     WHERE n.recipient_id = $1
     ORDER BY n.created_at DESC
     LIMIT $2 OFFSET $3`,
    [membershipNo, limit, offset]
  );
  return res.rows;
};

export const markNotificationRead = async (id: string, membershipNo: string) => {
  await pool.query(
    `UPDATE portal_notifications SET read = true WHERE id = $1 AND recipient_id = $2`,
    [id, membershipNo]
  );
};

export const markAllNotificationsRead = async (membershipNo: string) => {
  await pool.query(
    `UPDATE portal_notifications SET read = true WHERE recipient_id = $1 AND read = false`,
    [membershipNo]
  );
};

export const deleteNotification = async (id: string, membershipNo: string) => {
  await pool.query(
    `DELETE FROM portal_notifications WHERE id = $1 AND recipient_id = $2`,
    [id, membershipNo]
  );
};

// ═══════════════════════════════════════════════════
//  CHAT (used by socket.io)
// ═══════════════════════════════════════════════════

export const saveMessage = async (
  senderId: string,
  receiverId: string,
  content: string,
  type = 'text'
) => {
  const res = await pool.query(
    `INSERT INTO portal_messages (sender_id, receiver_id, content, type)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [senderId, receiverId, content, type]
  );
  return res.rows[0];
};

export const markMessagesRead = async (readerId: string, senderId: string) => {
  await pool.query(
    `UPDATE portal_messages SET read = true
     WHERE receiver_id = $1 AND sender_id = $2 AND read = false`,
    [readerId, senderId]
  );
};

// Inbox: one row per contact — last message + unread count, newest conversation first
export const getChatContacts = async (membershipNo: string): Promise<any[]> => {
  const res = await pool.query(
    `WITH conv AS (
       SELECT CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END AS contact_id,
              content, type, created_at
       FROM portal_messages
       WHERE sender_id = $1 OR receiver_id = $1
     ),
     latest AS (
       SELECT DISTINCT ON (contact_id) contact_id, content, type, created_at
       FROM conv
       ORDER BY contact_id, created_at DESC
     ),
     unread AS (
       SELECT sender_id AS contact_id, COUNT(*) AS unread_count
       FROM portal_messages
       WHERE receiver_id = $1 AND read = false
       GROUP BY sender_id
     )
     SELECT l.contact_id,
            m.name AS contact_name,
            m.profile_photo_url AS contact_avatar,
            l.content AS last_message,
            l.type AS last_message_type,
            l.created_at AS last_message_at,
            COALESCE(u.unread_count, 0)::int AS unread_count
     FROM latest l
     JOIN members m ON m.membership_no = l.contact_id
     LEFT JOIN unread u ON u.contact_id = l.contact_id
     ORDER BY l.created_at DESC`,
    [membershipNo]
  );
  return res.rows;
};

// Paginated message history between two members (newest page fetched first,
// returned in chronological order); marks the fetching side's inbox read.
export const getConversation = async (
  memberA: string,
  memberB: string,
  limit = 30,
  offset = 0
): Promise<any[]> => {
  const res = await pool.query(
    `SELECT * FROM portal_messages
     WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [memberA, memberB, limit, offset]
  );
  await markMessagesRead(memberA, memberB);
  return res.rows.reverse();
};
