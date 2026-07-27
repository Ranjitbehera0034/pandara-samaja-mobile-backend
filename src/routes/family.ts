import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as familyModel from '../models/familyModel';
import { uploadToFirebase, UPLOAD_PATHS, getSignedMediaUrl } from '../utils/firebaseStorage';
import { readMultipartFiles } from '../utils/multipart';

export default async function familyRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate);

  // ════════════════════════════════════════════════
  //  FAMILY ALBUMS
  // ════════════════════════════════════════════════

  fastify.get('/family/albums', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const albums = await familyModel.getAlbums(req.user.membership_no);
      const resolved = await Promise.all(albums.map(async (a: any) => ({
        ...a,
        cover_url: await getSignedMediaUrl(a.cover_url),
        photos: await Promise.all((a.photos || []).map(async (p: any) => ({ ...p, url: await getSignedMediaUrl(p.url) }))),
      })));
      return reply.send({ success: true, albums: resolved });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch albums' });
    }
  });

  fastify.post('/family/albums', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { files, fields } = await readMultipartFiles(req, ['cover']);
      if (!fields.title?.trim()) {
        return reply.status(400).send({ success: false, message: 'Album title is required' });
      }

      let coverUrl: string | null = null;
      if (files.cover[0]) {
        coverUrl = await uploadToFirebase(files.cover[0], UPLOAD_PATHS.MEMBER_FAMILY_ALBUM(req.user.membership_no));
      }

      const album = await familyModel.createAlbum(
        req.user.membership_no,
        fields.title.trim(),
        fields.description?.trim() || null,
        coverUrl
      );
      return reply.status(201).send({ success: true, album: { ...album, cover_url: await getSignedMediaUrl(album.cover_url) } });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to create album' });
    }
  });

  fastify.delete('/family/albums/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const deleted = await familyModel.deleteAlbum(id, req.user.membership_no);
      if (!deleted) return reply.status(404).send({ success: false, message: 'Album not found' });
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to delete album' });
    }
  });

  fastify.post('/family/albums/:id/photos', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const { files } = await readMultipartFiles(req, ['photos']);
      if (files.photos.length === 0) {
        return reply.status(400).send({ success: false, message: 'At least one photo is required' });
      }
      const urls = await Promise.all(
        files.photos.map((f) => uploadToFirebase(f, UPLOAD_PATHS.MEMBER_FAMILY_ALBUM(req.user.membership_no)))
      );
      const photos = await familyModel.addPhotosToAlbum(id, urls);
      const resolved = await Promise.all(photos.map(async (p: any) => ({ ...p, url: await getSignedMediaUrl(p.url) })));
      return reply.status(201).send({ success: true, photos: resolved });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to add photos' });
    }
  });

  // ════════════════════════════════════════════════
  //  FAMILY EVENTS
  // ════════════════════════════════════════════════

  fastify.get('/family/events', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const events = await familyModel.getEvents(req.user.membership_no);
      return reply.send({ success: true, events });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch events' });
    }
  });

  fastify.post('/family/events', async (req: FastifyRequest, reply: FastifyReply) => {
    const { title, description, eventDate, location, type } = req.body as any;
    if (!title?.trim() || !eventDate) {
      return reply.status(400).send({ success: false, message: 'Title and event date are required' });
    }
    try {
      const event = await familyModel.createEvent(
        req.user.membership_no,
        title.trim(),
        description?.trim() || null,
        eventDate,
        location?.trim() || null,
        type?.trim() || null
      );
      return reply.status(201).send({ success: true, event });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to create event' });
    }
  });

  fastify.delete('/family/events/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const deleted = await familyModel.deleteEvent(id, req.user.membership_no);
      if (!deleted) return reply.status(404).send({ success: false, message: 'Event not found' });
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to delete event' });
    }
  });

  fastify.post('/family/events/:id/rsvp', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { status } = req.body as any;
    if (!['going', 'not_going', 'maybe'].includes(status)) {
      return reply.status(400).send({ success: false, message: 'Invalid RSVP status' });
    }
    try {
      const rsvp = await familyModel.rsvpEvent(id, req.user.membership_no, status);
      return reply.send({ success: true, rsvp });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to RSVP' });
    }
  });
}
