import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as portalModel from '../models/portalModel';
import { uploadToFirebase, UPLOAD_PATHS, getSignedMediaUrl } from '../utils/firebaseStorage';
import pool from '../config/db';
import { logActivity } from '../utils/activityLog';
import { sendPushToMembers } from '../utils/pushNotifications';

export default async function feedRoutes(fastify: FastifyInstance) {

  // All feed routes require portal auth
  fastify.addHook('preHandler', fastify.authenticate);

  // ════════════════════════════════════════════════
  //  POSTS
  // ════════════════════════════════════════════════

  /**
   * GET /api/portal/posts
   * Fetch paginated feed posts with author info + liked_by_me
   * Matches web backend GET /api/portal/posts
   */
  fastify.get('/posts', async (req: FastifyRequest, reply: FastifyReply) => {
    const { page = '1', limit = '20' } = req.query as any;
    try {
      const posts = await portalModel.getPosts({
        page: parseInt(page),
        limit: Math.min(parseInt(limit), 50), // cap at 50
        membershipNo: req.user.membership_no,
      });

      return reply.send({
        success: true,
        posts,
        page: parseInt(page),
        limit: parseInt(limit),
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch posts' });
    }
  });

  /**
   * POST /api/portal/posts
   * Create a new community post (supports image uploads via multipart)
   * Matches web backend POST /api/portal/posts
   */
  fastify.post('/posts', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const parts = req.parts();
      let textContent = '';
      let location = '';
      const uploadedImageUrls: string[] = [];

      // Parse multipart form
      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'text') textContent = part.value as string;
          if (part.fieldname === 'location') location = part.value as string;
        } else if (part.type === 'file' && part.fieldname === 'images') {
          // Upload each image/video to Firebase Storage (matches the web
          // backend's storage so posts look identical regardless of which
          // app created them)
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk);
          }
          const buffer = Buffer.concat(chunks);

          if (buffer.length > 0) {
            try {
              const url = await uploadToFirebase(
                { buffer, originalname: part.filename || 'upload', mimetype: part.mimetype },
                UPLOAD_PATHS.MEMBER_POSTS(req.user.membership_no)
              );
              uploadedImageUrls.push(url);
            } catch (uploadErr) {
              fastify.log.error(uploadErr as any, '[POSTS] Image upload failed');
            }
          }
        }
      }

      if (!textContent.trim() && uploadedImageUrls.length === 0) {
        return reply.status(400).send({ success: false, message: 'Post must have text or images' });
      }

      const post = await portalModel.createPost({
        authorId: req.user.membership_no,
        authorName: req.user.name,
        authorPhoto: req.user.photo,
        authorMobile: req.user.mobile,
        textContent: textContent.trim() || undefined,
        images: uploadedImageUrls,
        location: location.trim() || undefined,
      });

      // Get full post with author data
      const fullPost = await portalModel.getPost(post.id.toString(), req.user.membership_no);

      await logActivity({
        actorType: 'member',
        actorId: req.user.membership_no,
        action: 'post_created',
        targetType: 'post',
        targetId: post.id.toString(),
        actorName: req.user.name,
        req,
      });

      // Emit socket event to all connected clients
      const io = fastify.io;
      if (io) {
        io.emit('new_post', {
          id: fullPost.id,
          author_id: fullPost.author_id,
          author_name: fullPost.author_name,
          author_photo: fullPost.author_photo,
          text_content: fullPost.text_content,
          images: fullPost.images || [],
          media: (fullPost.images || []).map((url: string) => ({ url, type: 'image' })),
          location: fullPost.location,
          likes_count: 0,
          comments_count: 0,
          created_at: fullPost.created_at,
        });
      }

      // Notify the poster's followers of the new post — in-app + push.
      // Wrapped so a failure here can never fail the post-creation response;
      // the post above has already succeeded and been sent to the client.
      try {
        const followersRes = await pool.query(
          'SELECT follower_id FROM portal_subscriptions WHERE following_id = $1',
          [req.user.membership_no]
        );
        const followerIds: string[] = followersRes.rows.map((r) => r.follower_id);

        if (followerIds.length > 0) {
          const posterName = req.user.name || 'Someone';
          await Promise.all(
            followerIds.map((followerId) =>
              portalModel.createNotification(
                followerId,
                'new_post',
                req.user.membership_no,
                `${posterName} shared a new post`,
                post.id.toString()
              )
            )
          );
          sendPushToMembers(
            followerIds,
            posterName,
            'shared a new post',
            { type: 'new_post', postId: post.id.toString() }
          ).catch(() => { /* never throws, defensive only */ });
        }
      } catch (notifyErr) {
        fastify.log.error(notifyErr as any, '[POSTS] Failed to notify followers of new post');
      }

      return reply.status(201).send({
        success: true,
        post: {
          ...fullPost,
          author_photo: fullPost.author_photo,
        },
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to create post' });
    }
  });

  /**
   * PUT /api/portal/posts/:id
   * Edit a post — only by the author
   */
  fastify.put('/posts/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { text } = req.body as any;

    if (!text?.trim()) {
      return reply.status(400).send({ success: false, message: 'Text is required' });
    }

    try {
      const post = await portalModel.editPost(id, req.user.membership_no, text.trim());
      if (!post) {
        return reply.status(404).send({ success: false, message: 'Post not found or not authorized' });
      }
      return reply.send({ success: true, post });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to edit post' });
    }
  });

  /**
   * DELETE /api/portal/posts/:id
   * Delete a post — only by the author
   */
  fastify.delete('/posts/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const deleted = await portalModel.deletePost(id, req.user.membership_no);
      if (!deleted) {
        return reply.status(404).send({ success: false, message: 'Post not found or not authorized' });
      }
      return reply.send({ success: true, message: 'Post deleted' });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to delete post' });
    }
  });

  /**
   * POST /api/portal/posts/:id/report
   * Report a post
   */
  fastify.post('/posts/:id/report', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { reason } = req.body as any;

    if (!reason?.trim()) {
      return reply.status(400).send({ success: false, message: 'Reason is required' });
    }

    try {
      await portalModel.reportPost(id, req.user.membership_no, reason.trim());
      return reply.send({ success: true, message: 'Report submitted' });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to submit report' });
    }
  });

  /**
   * POST /api/portal/posts/:id/share
   * Increment share count
   */
  fastify.post('/posts/:id/share', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await portalModel.sharePost(id);
      return reply.send({
        success: true,
        share_count: result?.share_count || 0,
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to record share' });
    }
  });

  /**
   * POST /api/portal/posts/:id/view
   * Record a video view
   */
  fastify.post('/posts/:id/view', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { durationSeconds = 0 } = req.body as any;
    try {
      await portalModel.recordView(id, req.user.membership_no, durationSeconds);
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to record view' });
    }
  });

  // ════════════════════════════════════════════════
  //  LIKES
  // ════════════════════════════════════════════════

  /**
   * POST /api/portal/posts/:id/like
   * Toggle like on a post
   * Emits like_updated socket event
   */
  fastify.post('/posts/:id/like', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await portalModel.toggleLike(id, req.user.membership_no, req.user.mobile || '');

      // Emit socket event — matches web backend exactly
      const io = fastify.io;
      if (io) {
        io.emit('like_updated', {
          postId: id.toString(),
          likes: result.likes_count,
        });
      }

      // Notify the post author on a new like (not on unlike, not on liking your own post)
      if (result.liked) {
        // Only log when the like is turning ON, not when it's toggled off.
        await logActivity({
          actorType: 'member',
          actorId: req.user.membership_no,
          action: 'post_liked',
          targetType: 'post',
          targetId: id.toString(),
          actorName: req.user.name,
          req,
        });
        try {
          const postRes = await pool.query('SELECT author_id FROM portal_posts WHERE id = $1', [id]);
          const authorId = postRes.rows[0]?.author_id;
          if (authorId && authorId !== req.user.membership_no) {
            await portalModel.createNotification(authorId, 'like', req.user.membership_no, 'liked your post', id.toString());
            const unread = await portalModel.getUnreadNotificationCount(authorId);
            io?.to(`user:${authorId}`).emit('notification_count', { count: unread });
            sendPushToMembers(
              [authorId],
              'New like',
              `${req.user.name || 'Someone'} liked your post`,
              { type: 'like', postId: id.toString() }
            ).catch(() => { /* never throws, defensive only */ });
          }
        } catch { /* silent */ }
      }

      return reply.send({
        success: true,
        liked: result.liked,
        likes_count: result.likes_count,
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to toggle like' });
    }
  });

  /**
   * POST /api/portal/comments/:id/like
   * Toggle like on a comment
   * Emits comment_like_updated socket event
   */
  fastify.post('/comments/:id/like', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await portalModel.toggleCommentLike(id, req.user.membership_no);

      const io = fastify.io;
      if (io) {
        io.emit('comment_like_updated', {
          commentId: id.toString(),
          likes: result.likes_count,
        });
      }

      return reply.send({
        success: true,
        liked: result.liked,
        likes_count: result.likes_count,
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to toggle comment like' });
    }
  });

  // ════════════════════════════════════════════════
  //  COMMENTS
  // ════════════════════════════════════════════════

  /**
   * GET /api/portal/posts/:id/comments
   * Get paginated comments for a post
   */
  fastify.get('/posts/:id/comments', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { page = '1', limit = '5' } = req.query as any;
    try {
      const result = await portalModel.getComments(
        id,
        parseInt(page),
        Math.min(parseInt(limit), 20)
      );
      return reply.send({ success: true, ...result });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch comments' });
    }
  });

  /**
   * POST /api/portal/posts/:id/comments
   * Add a comment or reply to a post
   * Emits new_comment socket event
   */
  fastify.post('/posts/:id/comments', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { text, parentId } = req.body as any;

    if (!text?.trim()) {
      return reply.status(400).send({ success: false, message: 'Comment text is required' });
    }

    try {
      const comment = await portalModel.addComment(
        id,
        req.user.membership_no,
        text.trim(),
        req.user.name,
        parentId?.toString(),
        req.user.photo,
        req.user.mobile
      );

      await logActivity({
        actorType: 'member',
        actorId: req.user.membership_no,
        action: 'comment_created',
        targetType: 'post',
        targetId: id.toString(),
        metadata: { commentId: comment.id },
        actorName: req.user.name,
        req,
      });

      // Emit socket event — matches web backend exactly
      const io = fastify.io;
      if (io) {
        io.emit('new_comment', {
          postId: id.toString(),
          comment: {
            id: comment.id,
            member_id: comment.member_id,
            author_name: comment.author_name,
            author_photo: comment.author_photo,
            text: comment.text,
            created_at: comment.created_at,
            parent_id: comment.parent_id,
            likes_count: 0,
          },
        });
      }

      // Notify the post author of the new comment (not when commenting on your own post)
      try {
        const postRes = await pool.query(
          'SELECT author_id FROM portal_posts WHERE id = $1',
          [id]
        );
        const authorId = postRes.rows[0]?.author_id;
        if (authorId && authorId !== req.user.membership_no) {
          await portalModel.createNotification(authorId, 'comment', req.user.membership_no, 'commented on your post', id.toString());
          const unread = await portalModel.getUnreadNotificationCount(authorId);
          io?.to(`user:${authorId}`).emit('notification_count', { count: unread });
          sendPushToMembers(
            [authorId],
            'New comment',
            `${req.user.name || 'Someone'} commented on your post`,
            { type: 'comment', postId: id.toString() }
          ).catch(() => { /* never throws, defensive only */ });
        }
      } catch { /* silent */ }

      return reply.status(201).send({ success: true, comment });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to add comment' });
    }
  });

  /**
   * DELETE /api/portal/comments/:id
   * Delete a comment — only by the author
   */
  fastify.delete('/comments/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const deleted = await portalModel.deleteComment(id, req.user.membership_no);
      if (!deleted) {
        return reply.status(404).send({ success: false, message: 'Comment not found or not authorized' });
      }
      return reply.send({ success: true, message: 'Comment deleted' });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to delete comment' });
    }
  });

  // ════════════════════════════════════════════════
  //  STORIES
  // ════════════════════════════════════════════════

  /**
   * GET /api/portal/stories
   * Fetch active stories (expires_at > NOW())
   */
  fastify.get('/stories', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      // COALESCE(s.author_photo, m.profile_photo_url): prefer the specific
      // person's own stored photo (set at story-creation time from their
      // JWT identity); fall back to the household's shared photo only for
      // stories created before this column existed.
      const result = await pool.query(
        `SELECT s.*, COALESCE(s.author_photo, m.profile_photo_url) AS author_avatar
         FROM portal_stories s
         LEFT JOIN members m ON s.author_id = m.membership_no
         WHERE s.expires_at > NOW()
         ORDER BY s.created_at DESC`
      );

      const stories = await Promise.all(result.rows.map(async (row) => ({
        id: row.id.toString(),
        authorId: row.author_id,
        authorName: row.author_name,
        authorAvatar: await getSignedMediaUrl(row.author_avatar),
        mediaUrl: await getSignedMediaUrl(row.media_url),
        mediaType: row.media_type,
        timestamp: row.created_at ? row.created_at.toISOString() : new Date().toISOString(),
        viewed: false,
        textOverlay: row.text_overlay || undefined
      })));

      return reply.send({
        success: true,
        stories,
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch stories' });
    }
  });

  /**
   * POST /api/portal/stories
   * Upload a story image/video and save metadata to portal_stories
   */
  fastify.post('/stories', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const parts = req.parts();
      let mediaType = 'image';
      let textOverlay = '';
      let mediaUrl = '';

      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'mediaType') mediaType = part.value as string;
          if (part.fieldname === 'textOverlay') textOverlay = part.value as string;
        } else if (part.type === 'file' && part.fieldname === 'media') {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk);
          }
          const buffer = Buffer.concat(chunks);

          if (buffer.length > 0) {
            try {
              mediaUrl = await uploadToFirebase(
                { buffer, originalname: part.filename || 'story_upload', mimetype: part.mimetype },
                UPLOAD_PATHS.MEMBER_STORIES(req.user.membership_no)
              );
            } catch (uploadErr) {
              fastify.log.error(uploadErr as any, '[STORIES] Media upload failed');
            }
          }
        }
      }

      if (!mediaUrl) {
        return reply.status(400).send({ success: false, message: 'Story media file is required' });
      }

      // Default story expiry is 24 hours from creation
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      // Store the specific logged-in person's own photo (from their JWT
      // identity) — the household head and any family member each have
      // their own distinct photo, and this must never collapse to
      // whichever photo happens to be on the shared `members` row.
      const res = await pool.query(
        `INSERT INTO portal_stories (author_id, author_name, author_photo, media_url, media_type, text_overlay, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         RETURNING *`,
        [req.user.membership_no, req.user.name, req.user.photo || null, mediaUrl, mediaType, textOverlay || null, expiresAt]
      );

      const story = res.rows[0];
      const authorAvatar = await getSignedMediaUrl(story.author_photo || null);

      return reply.status(201).send({
        success: true,
        story: {
          id: story.id.toString(),
          authorId: story.author_id,
          authorName: story.author_name,
          authorAvatar,
          mediaUrl: await getSignedMediaUrl(story.media_url),
          mediaType: story.media_type,
          timestamp: story.created_at ? story.created_at.toISOString() : new Date().toISOString(),
          viewed: false,
          textOverlay: story.text_overlay || undefined
        }
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to create story' });
    }
  });
}
