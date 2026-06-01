import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as portalModel from '../models/portalModel';
import { uploadFile } from '../services/googleDrive';
import pool from '../config/db';

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
          // Upload each image to Google Drive
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk);
          }
          const buffer = Buffer.concat(chunks);

          if (buffer.length > 0) {
            try {
              const url = await uploadFile({
                buffer,
                originalname: part.filename || 'upload',
                mimetype: part.mimetype,
              });
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
        textContent: textContent.trim() || undefined,
        images: uploadedImageUrls,
        location: location.trim() || undefined,
      });

      // Get full post with author data
      const fullPost = await portalModel.getPost(post.id.toString(), req.user.membership_no);

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
      const result = await portalModel.toggleLike(id, req.user.membership_no);

      // Emit socket event — matches web backend exactly
      const io = fastify.io;
      if (io) {
        io.emit('like_updated', {
          postId: id.toString(),
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
        parentId?.toString()
      );

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

      // Push unread notification count to post author
      try {
        const postRes = await pool.query(
          'SELECT author_id FROM portal_posts WHERE id = $1',
          [id]
        );
        const authorId = postRes.rows[0]?.author_id;
        if (authorId && authorId !== req.user.membership_no) {
          const unread = await portalModel.getUnreadNotificationCount(authorId);
          io?.to(`user:${authorId}`).emit('notification_count', { count: unread });
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
}
