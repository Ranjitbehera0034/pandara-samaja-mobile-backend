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
  max: 30,               // max connections in pool — enough headroom for
                          // several dozen concurrent users each holding a
                          // connection only for the duration of a single
                          // query, not for their whole session.
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  // Verified this Postgres host's certificate validates against Node's
  // default trusted root CAs — no need to disable verification.
  ssl: isProduction ? {
    rejectUnauthorized: true
  } : false,
});

// An idle pooled client can occasionally emit an 'error' (a transient
// network blip, the DB server closing a stale connection, a brief Postgres
// restart) that has NOTHING to do with any in-flight request — this is
// normal, expected behavior for a long-lived connection pool, not a fatal
// condition. The previous handler called process.exit(-1) here, which
// meant a single dropped idle connection would crash the ENTIRE backend
// for every currently-connected user, not just the one request that hit
// it — and the more concurrent users/connections there are, the more
// often some connection somewhere will have a transient hiccup, so this
// got proportionally more dangerous at higher concurrency, not less. `pg`
// already removes the broken client from the pool and creates a fresh one
// on the next query; just log it and keep serving everyone else.
pool.on('error', (err) => {
  console.error('[db] Pool client error (recovered, pool continues serving other connections):', err.message);
});

export default pool;
