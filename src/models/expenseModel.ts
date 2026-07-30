import pool from '../config/db';

// This operates on the REAL, pre-existing `expenses` table (already used by
// the web app, already has real data) — NOT the empty `community_expenses`
// table from migrations/002, which was a mistake: a redundant new table was
// built without checking for an existing one. Real columns: id, title,
// category, amount, description, payee, expense_date, attachment_url,
// recorded_by, created_at, updated_at. There is no income/type column —
// this table only tracks money spent, not money received.

export interface ExpenseListFilters {
  page?: number;
  limit?: number;
  category?: string;
}

export const list = async (filters: ExpenseListFilters): Promise<any[]> => {
  const { page = 1, limit = 20, category } = filters;
  const offset = (page - 1) * limit;
  const params: any[] = [];
  let wherePart = '';
  if (category) {
    params.push(category);
    wherePart = `WHERE category = $${params.length}`;
  }
  params.push(limit, offset);

  const res = await pool.query(
    `SELECT * FROM expenses
     ${wherePart}
     ORDER BY expense_date DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return res.rows;
};

export const count = async (category?: string): Promise<number> => {
  const params: any[] = [];
  let wherePart = '';
  if (category) {
    params.push(category);
    wherePart = `WHERE category = $1`;
  }
  const res = await pool.query(`SELECT COUNT(*) FROM expenses ${wherePart}`, params);
  return parseInt(res.rows[0].count, 10);
};

export const totalSpent = async (): Promise<number> => {
  const res = await pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM expenses`);
  return parseFloat(res.rows[0].total) || 0;
};

export const getCategories = async (): Promise<string[]> => {
  const res = await pool.query(`SELECT DISTINCT category FROM expenses WHERE category IS NOT NULL ORDER BY category`);
  return res.rows.map(r => r.category);
};

export interface ExpenseCreateInput {
  title: string;
  category: string;
  amount: number;
  description?: string | null;
  payee?: string | null;
  expenseDate?: string | null;
  attachmentUrl?: string | null;
  recordedBy: string;
}

export const create = async (data: ExpenseCreateInput): Promise<any> => {
  const res = await pool.query(
    `INSERT INTO expenses (title, category, amount, description, payee, expense_date, attachment_url, recorded_by)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE), $7, $8)
     RETURNING *`,
    [data.title, data.category, data.amount, data.description || null, data.payee || null, data.expenseDate || null, data.attachmentUrl || null, data.recordedBy]
  );
  return res.rows[0];
};

export interface ExpenseUpdateInput {
  title?: string;
  category?: string;
  amount?: number;
  description?: string | null;
  payee?: string | null;
  expenseDate?: string | null;
  attachmentUrl?: string | null;
}

export const update = async (id: string, data: ExpenseUpdateInput): Promise<any | null> => {
  const existing = await pool.query('SELECT * FROM expenses WHERE id = $1', [id]);
  const row = existing.rows[0];
  if (!row) return null;

  const merged = {
    title: data.title !== undefined ? data.title : row.title,
    category: data.category !== undefined ? data.category : row.category,
    amount: data.amount !== undefined ? data.amount : row.amount,
    description: data.description !== undefined ? data.description : row.description,
    payee: data.payee !== undefined ? data.payee : row.payee,
    expense_date: data.expenseDate !== undefined ? data.expenseDate : row.expense_date,
    attachment_url: data.attachmentUrl !== undefined ? data.attachmentUrl : row.attachment_url,
  };

  const res = await pool.query(
    `UPDATE expenses
     SET title = $1, category = $2, amount = $3, description = $4, payee = $5, expense_date = $6, attachment_url = $7, updated_at = NOW()
     WHERE id = $8
     RETURNING *`,
    [merged.title, merged.category, merged.amount, merged.description, merged.payee, merged.expense_date, merged.attachment_url, id]
  );
  return res.rows[0];
};

export const remove = async (id: string): Promise<any | null> => {
  const res = await pool.query('DELETE FROM expenses WHERE id = $1 RETURNING id', [id]);
  return res.rows[0] || null;
};
