// src/types/index.ts
import { FastifyReply } from 'fastify';

export interface Member {
  membership_no: string;
  name: string;
  head_gender: 'male' | 'female' | null;
  mobile: string;
  male: number | null;
  female: number | null;
  district: string | null;
  taluka: string | null;
  panchayat: string | null;
  village: string | null;
  aadhar_no: string | null;
  family_members: FamilyMember[];
  address: string | null;
  profile_photo_url?: string | null;
  last_portal_login?: string | null;
  is_banned?: boolean | null;
  state?: string | null;
}

export interface FamilyMember {
  name: string;
  relation: string;
  age: number | string;
  gender?: string;
  mobile?: string;
  profile_pic?: string | null;
  marital_status?: string;
}

export interface LoggedUser {
  name: string;
  relation: string;
  gender?: string;
  profile_photo_url?: string | null;
  mobile?: string;
  dob?: string | null;
}

// A membership_no is a HOUSEHOLD, not one person — the head of family plus
// any number of family members (each with their own mobile number) can all
// independently log in and use the app under the same membership_no. The
// JWT must carry enough of the specific logged-in person's own identity
// (not just the household's) for every subsequent action — posting,
// commenting, liking, uploading a profile photo — to be attributed to the
// right individual instead of always falling back to the household head.
//
// `familyIndex` is `null` when the logged-in person IS the head of family
// (their identity lives on the `members` row itself); otherwise it's the
// 0-based index of their entry in that household's `family_members` array
// (see portalModel.findByCredentials, which resolves this at login time).
export interface JwtPayload {
  membership_no: string;
  name: string;
  mobile?: string;
  photo?: string | null;
  familyIndex?: number | null;
  type: 'member_portal' | 'admin';
  iat?: number;
  exp?: number;
}

import { Server } from 'socket.io';

// Augment @fastify/jwt type definitions
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

// Augment Fastify request and instance types
declare module 'fastify' {
  interface FastifyRequest {
    user: JwtPayload;
  }
  interface FastifyInstance {
    authenticate: (request: any, reply: any) => Promise<void>;
    io: Server;
  }
}

