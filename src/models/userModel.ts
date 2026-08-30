import pool from '../config/db';
import bcrypt from 'bcryptjs';

// The `users` table is shared with the web app, which stores the top role as
// 'super_admin' (with an underscore) — confirmed directly against
// production (`SELECT id, username, role FROM users` shows the real
// superadmin account's role as exactly 'super_admin'). Every other part of
// this codebase (JWT payloads, admin route guards, activity_log
// actor_type, the mobile frontend's types) was built assuming 'superadmin'
// (no underscore) as the one canonical value — which meant the *actual*
// superadmin account never matched any of those `role === 'superadmin'`
// checks and was silently treated as a plain admin everywhere. Rather than
// hunt down and rewrite every comparison site across two repos, translate
// at this single boundary: everything above UserModel only ever sees/sends
// 'superadmin'; this file alone knows the DB spells it 'super_admin'.
const ROLE_TO_APP: Record<string, string> = { super_admin: 'superadmin' };
const ROLE_TO_DB: Record<string, string> = { superadmin: 'super_admin' };
const roleToApp = (role: string | null | undefined) => (role ? (ROLE_TO_APP[role] || role) : role);
const roleToDb = (role: string | null | undefined) => (role ? (ROLE_TO_DB[role] || role) : role);

export class UserModel {
  // Find user by username
  static async findByUsername(username: string) {
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { ...row, role: roleToApp(row.role) };
  }

  // Find user by ID
  static async findById(id: number | string) {
    const result = await pool.query(
      'SELECT id, username, role, email, membership_no, mobile, created_at, last_login, mfa_secret, is_mfa_active FROM users WHERE id = $1',
      [id]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { ...row, role: roleToApp(row.role) };
  }

  // Find admin account by email — used to enforce email uniqueness across
  // admin accounts before linking.
  static async findByEmail(email: string) {
    const result = await pool.query('SELECT id, username, role FROM users WHERE email = $1', [email]);
    const row = result.rows[0];
    if (!row) return null;
    return { ...row, role: roleToApp(row.role) };
  }

  // Find admin account by mobile — used to enforce mobile uniqueness across
  // admin accounts before linking, and to look up the account mid-login
  // (see the pending-OTP step in routes/admin.ts).
  static async findByMobile(mobile: string) {
    const result = await pool.query('SELECT id, username, role FROM users WHERE mobile = $1', [mobile]);
    const row = result.rows[0];
    if (!row) return null;
    return { ...row, role: roleToApp(row.role) };
  }

  // Create new user — `role` arrives in app format ('admin'|'superadmin').
  // `email`/`membershipNo`/`mobile` are optional at the DB level (existing
  // accounts predate the admin-identity-completeness requirement) but the
  // route layer requires all three for any *new* admin/superadmin account.
  static async create(username: string, password: string, role = 'user', email?: string, membershipNo?: string, mobile?: string) {
    try {
      const saltRounds = 10;
      const password_hash = await bcrypt.hash(password, saltRounds);

      const result = await pool.query(
        `INSERT INTO users (username, password_hash, role, email, membership_no, mobile)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, username, role, email, membership_no, mobile, created_at`,
        [username, password_hash, roleToDb(role), email || null, membershipNo || null, mobile || null]
      );

      const row = result.rows[0];
      return { ...row, role: roleToApp(row.role) };
    } catch (error: any) {
      if (error.code === '23505') { // Unique violation
        throw new Error('Username already exists');
      }
      throw error;
    }
  }

  // Verify password
  static async verifyPassword(plainPassword: string, hashedPassword: string) {
    return await bcrypt.compare(plainPassword, hashedPassword);
  }

  // Update last login time
  static async updateLastLogin(userId: number | string) {
    await pool.query(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [userId]
    );
  }

  // Update password
  static async updatePassword(userId: number | string, newPassword: string) {
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(newPassword, saltRounds);

    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [password_hash, userId]
    );

    return true;
  }

  // Delete user
  static async delete(userId: number | string) {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    return true;
  }

  // List all admin/superadmin accounts. 42703-safe: `is_active` is added by
  // migrations/002_admin_dashboard_expansion.sql and may not exist yet.
  static async findAll() {
    let result;
    try {
      result = await pool.query(
        'SELECT id, username, role, email, membership_no, mobile, created_at, last_login, is_active FROM users ORDER BY created_at DESC'
      );
    } catch (error: any) {
      if (error.code !== '42703') throw error;
      result = await pool.query(
        'SELECT id, username, role, email, membership_no, created_at, last_login FROM users ORDER BY created_at DESC'
      );
    }
    return result.rows.map(row => ({ ...row, role: roleToApp(row.role) }));
  }

  // Count accounts by role — used to guard against demoting the last
  // superadmin. `role` arrives in app format.
  static async countByRole(role: string): Promise<number> {
    const result = await pool.query('SELECT COUNT(*) FROM users WHERE role = $1', [roleToDb(role)]);
    return parseInt(result.rows[0].count, 10);
  }

  // Edit username/role/email/membershipNo/mobile of an existing admin
  // account. `data.role`, if provided, arrives in app format.
  static async update(id: number | string, data: { username?: string; role?: string; email?: string; membershipNo?: string; mobile?: string }) {
    const existing = await pool.query('SELECT id, username, role, email, membership_no, mobile FROM users WHERE id = $1', [id]);
    const row = existing.rows[0];
    if (!row) return null;

    const username = data.username !== undefined ? data.username : row.username;
    const role = data.role !== undefined ? roleToDb(data.role) : row.role;
    const email = data.email !== undefined ? data.email : row.email;
    const membershipNo = data.membershipNo !== undefined ? data.membershipNo : row.membership_no;
    const mobile = data.mobile !== undefined ? data.mobile : row.mobile;

    try {
      const result = await pool.query(
        `UPDATE users SET username = $1, role = $2, email = $3, membership_no = $4, mobile = $5 WHERE id = $6
         RETURNING id, username, role, email, membership_no, mobile, created_at, last_login`,
        [username, role, email, membershipNo, mobile, id]
      );
      const updated = result.rows[0];
      return { ...updated, role: roleToApp(updated.role) };
    } catch (error: any) {
      if (error.code === '23505') {
        throw new Error('Username already exists');
      }
      throw error;
    }
  }

  // Enable/disable an admin account. 42703-safe: `is_active` is added by
  // migrations/002_admin_dashboard_expansion.sql and may not exist yet.
  static async setActive(id: number | string, active: boolean): Promise<{ ok: boolean; user: any | null }> {
    try {
      const result = await pool.query(
        'UPDATE users SET is_active = $1 WHERE id = $2 RETURNING id, username, role, is_active',
        [active, id]
      );
      const row = result.rows[0];
      return { ok: true, user: row ? { ...row, role: roleToApp(row.role) } : null };
    } catch (error: any) {
      if (error.code !== '42703') throw error;
      console.warn('[UserModel.setActive] users.is_active column missing — run the pending migration.');
      return { ok: false, user: null };
    }
  }

  // Update MFA Secret
  static async updateMfaSecret(userId: number | string, secret: string) {
    await pool.query('UPDATE users SET mfa_secret = $1 WHERE id = $2', [secret, userId]);
    return true;
  }

  // Activate MFA
  static async activateMfa(userId: number | string) {
    await pool.query('UPDATE users SET is_mfa_active = true WHERE id = $1', [userId]);
    return true;
  }
}

export default UserModel;
