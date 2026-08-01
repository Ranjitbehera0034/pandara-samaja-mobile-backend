import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import * as portalModel from '../models/portalModel';
import * as memberModel from '../models/memberModel';
import { generateOtp } from '../services/otp';
import { JWT_SECRET, PORTAL_JWT_EXPIRES } from '../config/secrets';
import { auth as firebaseAuth } from '../config/firebase';
import { logActivity } from '../utils/activityLog';
import { getSignedMediaUrl } from '../utils/firebaseStorage';

// In-memory OTP-verify attempt lockout, keyed by membership_no:mobile.
// Resets on server restart — acceptable for now since there's no
// migrations/schema-versioning infra yet to back this with a DB column.
const MAX_OTP_ATTEMPTS = 5;
const otpAttempts = new Map<string, { count: number; lockedUntil: number }>();

function otpAttemptKey(membershipNo: string, mobile: string) {
  return `${membershipNo}:${mobile}`;
}

export default async function authRoutes(fastify: FastifyInstance) {

  // ── POST /api/portal/login ──
  // Step 1: Validate credentials + save standard OTP (printed to console in dev mode)
  fastify.post('/login', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        // Key by IP + the membership_no being logged into, not IP alone.
        // Many Indian mobile carriers share one public IP across a large
        // number of distinct subscribers (carrier-grade NAT) — under IP-only
        // keying, a burst of genuinely different people logging in around
        // the same time (e.g. right after being told to download the app)
        // could get falsely throttled as if they were one person retrying.
        // Keying by IP+identity still fully blocks repeated guesses against
        // one specific membership_no from one IP, which is the actual
        // brute-force scenario this limit exists to stop.
        keyGenerator: (req: any) => `${req.ip}:${req.body?.membership_no || ''}`,
      },
    },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { membership_no, mobile } = req.body as any;

    if (!membership_no || !mobile) {
      return reply.status(400).send({
        success: false,
        message: 'Membership number and mobile number are required',
      });
    }

    const cleanMobile = mobile.replace(/\D/g, '');
    if (cleanMobile.length < 10) {
      return reply.status(400).send({
        success: false,
        message: 'Please enter a valid 10-digit mobile number',
      });
    }

    try {
      const result = await portalModel.findByCredentials(membership_no.trim(), cleanMobile);
      if (!result) {
        return reply.status(401).send({
          success: false,
          message: 'No matching member found. Please check your Membership No. and Mobile Number.',
        });
      }

      const otp = generateOtp();
      await portalModel.saveOtp(membership_no.trim(), cleanMobile, otp);

      const { NODE_ENV, BYPASS_FIREBASE_OTP } = require('../config/secrets');
      if (NODE_ENV === 'development' && BYPASS_FIREBASE_OTP) {
        console.log(`\n==========================================`);
        console.log(`🔑 DEV MODE OTP GENERATION:`);
        console.log(`   Membership No: ${membership_no}`);
        console.log(`   Mobile:        ${cleanMobile}`);
        console.log(`   Generated OTP:  ${otp}`);
        console.log(`==========================================\n`);

        return reply.send({
          success: true,
          message: 'OTP generated (dev bypass active: check console)',
          requireOtp: true,
          devOtp: otp
        });
      }

      return reply.send({
        success: true,
        message: 'Member verified. Proceed with Firebase OTP verification.',
        requireOtp: true
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Internal server error' });
    }
  });

  // ── POST /api/portal/verify-otp ──
  // Step 2a: Verify standard OTP via bcrypt → issue JWT
  fastify.post('/verify-otp', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        // Same reasoning as /login above — key by IP+identity, not IP alone.
        keyGenerator: (req: any) => `${req.ip}:${req.body?.membership_no || ''}`,
      },
    },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { membership_no, mobile, otp } = req.body as any;

    if (!membership_no || !mobile || !otp) {
      return reply.status(400).send({ success: false, message: 'Missing parameters' });
    }

    const cleanMobile = mobile.replace(/\D/g, '');
    const attemptKey = otpAttemptKey(membership_no.trim(), cleanMobile);
    const attempt = otpAttempts.get(attemptKey);

    if (attempt && attempt.count >= MAX_OTP_ATTEMPTS && Date.now() < attempt.lockedUntil) {
      return reply.status(423).send({
        success: false,
        message: 'Too many incorrect attempts. Please request a new OTP and try again shortly.',
      });
    }

    try {
      const result = await portalModel.findByCredentials(membership_no.trim(), cleanMobile);
      if (!result) {
        return reply.status(401).send({ success: false, message: 'Member lookup failed' });
      }

      const isValid = await portalModel.verifyOtpCode(membership_no.trim(), cleanMobile, otp.trim());
      if (!isValid) {
        const nextCount = (attempt?.count || 0) + 1;
        otpAttempts.set(attemptKey, { count: nextCount, lockedUntil: Date.now() + 5 * 60 * 1000 });
        return reply.status(401).send({ success: false, message: 'Invalid or expired OTP' });
      }
      otpAttempts.delete(attemptKey);

      const { member, matchedUser } = result;

      const token = jwt.sign(
        {
          membership_no: member.membership_no,
          name: matchedUser.name || member.name,
          mobile: matchedUser.mobile,
          photo: matchedUser.profile_photo_url,
          familyIndex: matchedUser.familyIndex,
          type: 'member_portal',
        },
        JWT_SECRET,
        { expiresIn: PORTAL_JWT_EXPIRES as any }
      );

      const userProfile = await portalModel.getLoggedUserProfile(member.membership_no);

      await logActivity({
        actorType: 'member',
        actorId: member.membership_no,
        actorName: matchedUser.name || member.name,
        action: 'login',
        metadata: { method: 'otp' },
        req,
      });

      return reply.send({
        success: true,
        message: 'Login successful',
        token,
        member: await portalModel.sanitizeMemberForClient(member),
        loggedInUser: userProfile || {
          name: matchedUser.name,
          relation: matchedUser.relation,
          gender: matchedUser.gender,
          profile_photo_url: await getSignedMediaUrl(matchedUser.profile_photo_url),
        },
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Internal server error' });
    }
  });

  // ── POST /api/portal/login/firebase ──
  // Step 2b: Verify Firebase phone auth → issue JWT
  fastify.post('/login/firebase', async (req: FastifyRequest, reply: FastifyReply) => {
    const { idToken, membership_no, mobile } = req.body as any;

    if (!idToken || !membership_no || !mobile) {
      return reply.status(400).send({ success: false, message: 'Missing parameters' });
    }

    const cleanMobile = mobile.replace(/\D/g, '');

    try {
      // Verify Firebase ID token
      const decodedToken = await firebaseAuth.verifyIdToken(idToken);
      const firebaseMobile = (decodedToken.phone_number || '').replace(/\D/g, '');

      // Ensure Firebase phone matches claimed mobile
      if (!firebaseMobile || !firebaseMobile.endsWith(cleanMobile)) {
        return reply.status(401).send({
          success: false,
          message: 'Mobile number does not match Firebase token',
        });
      }

      const result = await portalModel.findByCredentials(membership_no.trim(), cleanMobile);
      if (!result) {
        return reply.status(401).send({
          success: false,
          message: 'No matching member found',
        });
      }

      const { member, matchedUser } = result;

      const token = jwt.sign(
        {
          membership_no: member.membership_no,
          name: matchedUser.name || member.name,
          mobile: matchedUser.mobile,
          photo: matchedUser.profile_photo_url,
          familyIndex: matchedUser.familyIndex,
          type: 'member_portal',
        },
        JWT_SECRET,
        { expiresIn: PORTAL_JWT_EXPIRES as any }
      );

      const userProfile = await portalModel.getLoggedUserProfile(member.membership_no);

      await logActivity({
        actorType: 'member',
        actorId: member.membership_no,
        actorName: matchedUser.name || member.name,
        action: 'login',
        metadata: { method: 'firebase' },
        req,
      });

      return reply.send({
        success: true,
        message: 'Login successful',
        token,
        member: await portalModel.sanitizeMemberForClient(member),
        loggedInUser: userProfile || {
          name: matchedUser.name,
          relation: matchedUser.relation,
          gender: matchedUser.gender,
          profile_photo_url: await getSignedMediaUrl(matchedUser.profile_photo_url),
        },
      });
    } catch (err: any) {
      fastify.log.error(err);
      if (err.code?.startsWith('auth/')) {
        return reply.status(401).send({ success: false, message: 'Invalid Firebase token' });
      }
      return reply.status(500).send({ success: false, message: 'Internal server error' });
    }
  });

  // ── POST /api/portal/refresh ──
  // NEW for mobile: Refresh JWT without re-login
  fastify.post('/refresh', {
    preHandler: [fastify.authenticate],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.user;

    try {
      // Raw (unsigned) row — needed so the JWT's `photo` claim stays a
      // stable Firebase path, not a signed URL that would expire within the
      // hour and get baked permanently into any post/comment authored
      // during this 365-day session (see logActivity/createPost callers
      // that denormalize req.user.photo into author_photo at write time).
      const rawMember = await memberModel.getOne(user.membership_no);
      if (!rawMember) {
        return reply.status(401).send({ success: false, message: 'Member not found' });
      }
      if (rawMember.is_banned) {
        return reply.status(403).send({ success: false, message: 'This account has been suspended' });
      }

      // Re-derive the specific logged-in person's CURRENT name/photo from
      // family_members using the known familyIndex from the token being
      // refreshed — refresh has no mobile number to re-match against
      // family_members with, but the index itself is stable and lets us
      // pick up any photo/name change since the last login instead of
      // perpetuating a stale value for the life of a 365-day session.
      const familyMembers = Array.isArray(rawMember.family_members)
        ? rawMember.family_members
        : (() => { try { return JSON.parse(rawMember.family_members || '[]'); } catch { return []; } })();
      const isHead = user.familyIndex === null || user.familyIndex === undefined;
      const currentEntry = isHead ? null : familyMembers[user.familyIndex as number];
      const currentName = isHead ? rawMember.name : (currentEntry?.name || user.name);
      const currentPhotoRaw = isHead ? rawMember.profile_photo_url : currentEntry?.profile_pic;

      const newToken = jwt.sign(
        {
          membership_no: user.membership_no,
          name: currentName,
          mobile: user.mobile,
          photo: currentPhotoRaw ?? user.photo,
          familyIndex: user.familyIndex,
          type: 'member_portal',
        },
        JWT_SECRET,
        { expiresIn: PORTAL_JWT_EXPIRES as any }
      );

      return reply.send({
        success: true,
        token: newToken,
        member: await portalModel.sanitizeMemberForClient(rawMember),
        loggedInUser: {
          name: currentName,
          relation: isHead ? 'Self' : (currentEntry?.relation || null),
          gender: isHead ? rawMember.head_gender : (currentEntry?.gender || null),
          profile_photo_url: await getSignedMediaUrl(currentPhotoRaw ?? null),
        },
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Internal server error' });
    }
  });
}
