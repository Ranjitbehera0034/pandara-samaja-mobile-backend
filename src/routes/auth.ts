import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import * as portalModel from '../models/portalModel';
import { generateOtp } from '../services/otp';
import { JWT_SECRET, PORTAL_JWT_EXPIRES } from '../config/secrets';
import { auth as firebaseAuth } from '../config/firebase';

export default async function authRoutes(fastify: FastifyInstance) {

  // ── POST /api/portal/login ──
  // Step 1: Validate credentials + save standard OTP (printed to console in dev mode)
  fastify.post('/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, // Strict rate limit on login
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

      const { NODE_ENV } = require('../config/secrets');
      if (NODE_ENV === 'development') {
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
  fastify.post('/verify-otp', async (req: FastifyRequest, reply: FastifyReply) => {
    const { membership_no, mobile, otp } = req.body as any;

    if (!membership_no || !mobile || !otp) {
      return reply.status(400).send({ success: false, message: 'Missing parameters' });
    }

    const cleanMobile = mobile.replace(/\D/g, '');

    try {
      const result = await portalModel.findByCredentials(membership_no.trim(), cleanMobile);
      if (!result) {
        return reply.status(401).send({ success: false, message: 'Member lookup failed' });
      }

      const isValid = await portalModel.verifyOtpCode(membership_no.trim(), cleanMobile, otp.trim());
      if (!isValid) {
        return reply.status(401).send({ success: false, message: 'Invalid or expired OTP' });
      }

      const { member, matchedUser } = result;

      const token = jwt.sign(
        {
          membership_no: member.membership_no,
          name: matchedUser.name || member.name,
          type: 'member_portal',
        },
        JWT_SECRET,
        { expiresIn: PORTAL_JWT_EXPIRES as any }
      );

      const userProfile = await portalModel.getLoggedUserProfile(member.membership_no);

      return reply.send({
        success: true,
        message: 'Login successful',
        token,
        member: {
          membership_no: member.membership_no,
          name: member.name,
          mobile: member.mobile,
          district: member.district,
          taluka: member.taluka,
          panchayat: member.panchayat,
          village: member.village,
          address: member.address,
        },
        loggedInUser: userProfile || {
          name: matchedUser.name,
          relation: matchedUser.relation,
          gender: matchedUser.gender,
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
          type: 'member_portal',
        },
        JWT_SECRET,
        { expiresIn: PORTAL_JWT_EXPIRES as any }
      );

      const userProfile = await portalModel.getLoggedUserProfile(member.membership_no);

      return reply.send({
        success: true,
        message: 'Login successful',
        token,
        member: {
          membership_no: member.membership_no,
          name: member.name,
          mobile: member.mobile,
          district: member.district,
          taluka: member.taluka,
          panchayat: member.panchayat,
          village: member.village,
          address: member.address,
        },
        loggedInUser: userProfile || {
          name: matchedUser.name,
          relation: matchedUser.relation,
          gender: matchedUser.gender,
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
      // Verify member still exists in DB
      const member = await portalModel.getMemberProfile(user.membership_no);
      if (!member) {
        return reply.status(401).send({ success: false, message: 'Member not found' });
      }

      // Issue fresh token
      const newToken = jwt.sign(
        {
          membership_no: user.membership_no,
          name: user.name,
          type: 'member_portal',
        },
        JWT_SECRET,
        { expiresIn: PORTAL_JWT_EXPIRES as any }
      );

      return reply.send({ success: true, token: newToken });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Internal server error' });
    }
  });
}
