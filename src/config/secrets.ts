import dotenv from 'dotenv';
dotenv.config();

const required = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
};

export const JWT_SECRET = required('JWT_SECRET');
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
export const PORTAL_JWT_EXPIRES = process.env.PORTAL_JWT_EXPIRES || '7d';
export const PORT = parseInt(process.env.PORT || '6000');
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY || '';
