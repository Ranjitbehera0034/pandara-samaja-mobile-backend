import pool from '../config/db';

// The `community_expenses` table is brand new (see
// migrations/002_admin_dashboard_expansion.sql) and may not exist yet on
// every environment. Every function here catches 42P01 (undefined_table)
// and returns an `ok: false` result instead of throwing, so callers can
// degrade gracefully (empty list / 503-ish "pending migration" response)
// rather than 500-crashing.

export interface ExpenseListFilters {
  page?: number;
  limit?: number;
  type?: 'income' | 'expense';
}

export const list = async (filters: ExpenseListFilters): Promise<{ ok: boolean; rows: any[] }> => {
  const { page = 1, limit = 20, type } = filters;
  const offset = (page - 1) * limit;
  const params: any[] = [];
  let wherePart = '';
  if (type) {
    params.push(type);
    wherePart = `WHERE type = $${params.length}`;
  }
  params.push(limit, offset);

  try {
    const res = await pool.query(
      `SELECT * FROM community_expenses
       ${wherePart}
       ORDER BY entry_date DESC, id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return { ok: true, rows: res.rows };
  } catch (err: any) {
    if (err.code !== '42P01') throw err;
    console.warn('[expenseModel.list] community_expenses table missing — run the pending migration.');
    return { ok: false, rows: [] };
  }
};

export const count = async (type?: 'income' | 'expense'): Promise<{ ok: boolean; total: number }> => {
  const params: any[] = [];
  let wherePart = '';
  if (type) {
    params.push(type);
    wherePart = `WHERE type = $1`;
  }
  try {
    const res = await pool.query(`SELECT COUNT(*) FROM community_expenses ${wherePart}`, params);
    return { ok: true, total: parseInt(res.rows[0].count, 10) };
  } catch (err: any) {
    if (err.code !== '42P01') throw err;
    return { ok: false, total: 0 };
  }
};

export const summary = async (): Promise<{ ok: boolean; totalIncome: number; totalExpense: number; balance: number }> => {
  try {
    const res = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS total_income,
         COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expense
       FROM community_expenses`
    );
    const totalIncome = parseFloat(res.rows[0].total_income) || 0;
    const totalExpense = parseFloat(res.rows[0].total_expense) || 0;
    return { ok: true, totalIncome, totalExpense, balance: totalIncome - totalExpense };
  } catch (err: any) {
    if (err.code !== '42P01') throw err;
    return { ok: false, totalIncome: 0, totalExpense: 0, balance: 0 };
  }
};

export interface ExpenseCreateInput {
  title: string;
  type: 'income' | 'expense';
  amount: number;
  category?: string | null;
  note?: string | null;
  entryDate?: string | null;
  createdBy?: number | null;
}

export const create = async (data: ExpenseCreateInput): Promise<{ ok: boolean; row: any | null }> => {
  try {
    const res = await pool.query(
      `INSERT INTO community_expenses (title, type, amount, category, note, entry_date, created_by)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE), $7)
       RETURNING *`,
      [data.title, data.type, data.amount, data.category || null, data.note || null, data.entryDate || null, data.createdBy || null]
    );
    return { ok: true, row: res.rows[0] };
  } catch (err: any) {
    if (err.code !== '42P01') throw err;
    console.warn('[expenseModel.create] community_expenses table missing — run the pending migration.');
    return { ok: false, row: null };
  }
};

export interface ExpenseUpdateInput {
  title?: string;
  type?: 'income' | 'expense';
  amount?: number;
  category?: string | null;
  note?: string | null;
  entryDate?: string | null;
}

export const update = async (id: string, data: ExpenseUpdateInput): Promise<{ ok: boolean; row: any | null }> => {
  try {
    const existing = await pool.query('SELECT * FROM community_expenses WHERE id = $1', [id]);
    const row = existing.rows[0];
    if (!row) return { ok: true, row: null };

    const merged = {
      title: data.title !== undefined ? data.title : row.title,
      type: data.type !== undefined ? data.type : row.type,
      amount: data.amount !== undefined ? data.amount : row.amount,
      category: data.category !== undefined ? data.category : row.category,
      note: data.note !== undefined ? data.note : row.note,
      entry_date: data.entryDate !== undefined ? data.entryDate : row.entry_date,
    };

    const res = await pool.query(
      `UPDATE community_expenses
       SET title = $1, type = $2, amount = $3, category = $4, note = $5, entry_date = $6, updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [merged.title, merged.type, merged.amount, merged.category, merged.note, merged.entry_date, id]
    );
    return { ok: true, row: res.rows[0] };
  } catch (err: any) {
    if (err.code !== '42P01') throw err;
    console.warn('[expenseModel.update] community_expenses table missing — run the pending migration.');
    return { ok: false, row: null };
  }
};

export const remove = async (id: string): Promise<{ ok: boolean; row: any | null }> => {
  try {
    const res = await pool.query('DELETE FROM community_expenses WHERE id = $1 RETURNING id', [id]);
    return { ok: true, row: res.rows[0] || null };
  } catch (err: any) {
    if (err.code !== '42P01') throw err;
    console.warn('[expenseModel.remove] community_expenses table missing — run the pending migration.');
    return { ok: false, row: null };
  }
};
