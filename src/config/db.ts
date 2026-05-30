import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

// Determine if SSL is needed (for Render or other hosted databases)
const isProduction = process.env.DATABASE_URL && (
  process.env.DATABASE_URL.includes('render.com') ||
  process.env.DATABASE_URL.includes('amazonaws.com') ||
  process.env.NODE_ENV === 'production'
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,               // max connections in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  ssl: isProduction ? {
    rejectUnauthorized: false
  } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error', err);
  process.exit(-1);
});

export default pool;
