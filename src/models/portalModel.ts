import pool from '../config/db';
import { decrypt } from '../utils/encryption';
import bcrypt from 'bcryptjs';

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
  let matchedUser = null;

  if (memberMobile === cleanMobile) {
    matchedUser = {
      name: member.name,
      relation: 'Self/Head',
      mobile: member.mobile || '',
      profile_photo_url: member.profile_photo_url || null,
      gender: member.head_gender || null
    };
  } else {
    // Check family members
    const familyMembers = Array.isArray(member.family_members)
      ? member.family_members
      : JSON.parse(member.family_members || '[]');

    for (const fm of familyMembers) {
      const fmMobile = (fm.mobile || '').replace(/\D/g, '').slice(-10);
      if (fmMobile && fmMobile === cleanMobile) {
        matchedUser = {
          name: fm.name,
          relation: fm.relation,
          mobile: fm.mobile || '',
          profile_photo_url: fm.profile_photo_url || null,
          gender: fm.gender || null
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
  if (member && member.aadhar_no) {
    member.aadhar_no = decrypt(member.aadhar_no);
  }
  return member || null;
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
}: {
  authorId: string;
  textContent?: string;
  images?: string[];
  location?: string;
  authorName?: string;
}) => {
  const res = await pool.query(
    `INSERT INTO portal_posts (author_id, text_content, images, location, author_name)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [authorId, textContent || null, images || [], location || null, authorName || null]
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
  const res = await pool.query(
    `SELECT p.*,
        COALESCE(p.author_name, m.name) AS author_name,
        m.village AS author_village,
        m.district AS author_district,
        m.profile_photo_url AS author_photo,
        EXISTS(
          SELECT 1 FROM portal_likes l
          WHERE l.post_id = p.id AND l.member_id = $3
        ) AS liked_by_me
     FROM portal_posts p
     JOIN members m ON m.membership_no = p.author_id
     ORDER BY p.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset, membershipNo]
  );
  return res.rows;
};

/**
 * Get single post with author data
 */
export const getPost = async (postId: string, membershipNo: string) => {
  const res = await pool.query(
    `SELECT p.*,
        COALESCE(p.author_name, m.name) AS author_name,
        m.profile_photo_url AS author_photo,
        EXISTS(
          SELECT 1 FROM portal_likes l
          WHERE l.post_id = p.id AND l.member_id = $2
        ) AS liked_by_me
     FROM portal_posts p
     JOIN members m ON m.membership_no = p.author_id
     WHERE p.id = $1`,
    [postId, membershipNo]
  );
  return res.rows[0] || null;
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
  return res.rows[0];
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
export const toggleLike = async (postId: string, memberId: string) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the post row
    await client.query(
      `SELECT id FROM portal_posts WHERE id = $1 FOR UPDATE`,
      [postId]
    );

    // Check if already liked
    const existing = await client.query(
      `SELECT id FROM portal_likes WHERE post_id = $1 AND member_id = $2`,
      [postId, memberId]
    );

    let liked: boolean;
    if (existing.rows.length > 0) {
      // Unlike
      await client.query(
        `DELETE FROM portal_likes WHERE post_id = $1 AND member_id = $2`,
        [postId, memberId]
      );
      await client.query(
        `UPDATE portal_posts SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = $1`,
        [postId]
      );
      liked = false;
    } else {
      // Like
      await client.query(
        `INSERT INTO portal_likes (post_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [postId, memberId]
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
  parentId?: string
) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const res = await client.query(
      `INSERT INTO portal_comments (post_id, member_id, text, author_name, parent_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [postId, memberId, text, authorName || null, parentId || null]
    );

    await client.query(
      `UPDATE portal_posts SET comments_count = comments_count + 1 WHERE id = $1`,
      [postId]
    );

    // Fetch with author photo
    const commentWithAuthor = await client.query(
      `SELECT c.*, COALESCE(c.author_name, m.name) AS author_name, m.profile_photo_url AS author_photo
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
            m.profile_photo_url AS author_photo,
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
