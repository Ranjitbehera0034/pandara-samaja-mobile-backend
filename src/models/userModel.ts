import pool from '../config/db';
import bcrypt from 'bcryptjs';

export class UserModel {
  // Find user by username
  static async findByUsername(username: string) {
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );
    return result.rows[0] || null;
  }

  // Find user by ID
  static async findById(id: number | string) {
    const result = await pool.query(
      'SELECT id, username, role, created_at, last_login, mfa_secret, is_mfa_active FROM users WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  // Create new user
  static async create(username: string, password: string, role = 'user') {
    try {
      const saltRounds = 10;
      const password_hash = await bcrypt.hash(password, saltRounds);

      const result = await pool.query(
        `INSERT INTO users (username, password_hash, role)
         VALUES ($1, $2, $3)
         RETURNING id, username, role, created_at`,
        [username, password_hash, role]
      );

      return result.rows[0];
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
