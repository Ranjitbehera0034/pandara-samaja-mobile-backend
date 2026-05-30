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
  profile_photo_url?: string | null;
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

export interface JwtPayload {
  membership_no: string;
  name: string;
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

