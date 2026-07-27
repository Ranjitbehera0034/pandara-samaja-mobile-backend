import pool from '../config/db';
import UserModel from '../models/userModel';

/**
 * Creates the first superadmin account from env vars if the `users` table
 * is empty. There's no seeding/migration tooling in this repo and no DB
 * access for an operator to insert one by hand, so this is the only way to
 * bootstrap admin login at all. Deliberately requires explicit env vars
 * rather than a hardcoded default (the ENCRYPTION_KEY incident earlier in
 * this project is exactly the failure mode being avoided here) — if they're
 * not set, this just logs a warning and skips, it does not fail server
 * startup, since admin bootstrap failing shouldn't take down the app for
 * regular members.
 */
export async function bootstrapDefaultAdmin(): Promise<void> {
  try {
    const countRes = await pool.query('SELECT COUNT(*) FROM users');
    if (parseInt(countRes.rows[0].count, 10) > 0) return;

    const username = process.env.DEFAULT_ADMIN_USERNAME;
    const password = process.env.DEFAULT_ADMIN_PASSWORD;
    if (!username || !password) {
      console.warn(
        '[ADMIN BOOTSTRAP] No admin users exist yet, and DEFAULT_ADMIN_USERNAME / ' +
        'DEFAULT_ADMIN_PASSWORD are not set — skipping. Set both env vars and restart ' +
        'to create the first superadmin account.'
      );
      return;
    }

    await UserModel.create(username.trim(), password, 'superadmin');
    console.log(`[ADMIN BOOTSTRAP] Created initial superadmin account: ${username}`);
  } catch (err: any) {
    // Most likely cause: the `users` table doesn't exist yet in this
    // database. Don't crash server startup over it — admin login just
    // won't work until the table exists.
    console.warn('[ADMIN BOOTSTRAP] Skipped — could not query/create users table:', err.message);
  }
}
