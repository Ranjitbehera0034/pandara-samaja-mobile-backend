import pool from '../config/db';

// This operates on the REAL, pre-existing `expenses` table (already used by
// the web app, already has real data) — NOT the empty `community_expenses`
// table from migrations/002, which was a mistake: a redundant new table was
// built without checking for an existing one. Real columns: id, title,
// category, amount, description, payee, expense_date, attachment_url,
// recorded_by, created_at, updated_at. There is no income/type column —
// this table only tracks money spent, not money received.

export type ExpenseSort = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc';

const SORT_MAP: Record<ExpenseSort, string> = {
  date_desc: 'expense_date DESC, id DESC',
  date_asc: 'expense_date ASC, id ASC',
  amount_desc: 'amount DESC, expense_date DESC',
  amount_asc: 'amount ASC, expense_date DESC',
};

// month is 'YYYY-MM' — filters by expense_date falling in that calendar month.
function buildWhere(category?: string, month?: string) {
  const params: any[] = [];
  const conditions: string[] = [];
  if (category) { params.push(category); conditions.push(`category = $${params.length}`); }
  if (month) { params.push(month); conditions.push(`to_char(expense_date, 'YYYY-MM') = $${params.length}`); }
  return { conditions, params };
}

export interface ExpenseListFilters {
  page?: number;
  limit?: number;
  category?: string;
  month?: string;
  sort?: ExpenseSort;
}

export const list = async (filters: ExpenseListFilters): Promise<any[]> => {
  const { page = 1, limit = 20, category, month, sort = 'date_desc' } = filters;
  const offset = (page - 1) * limit;
  const { conditions, params } = buildWhere(category, month);
  const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = SORT_MAP[sort] || SORT_MAP.date_desc;
  params.push(limit, offset);

  const res = await pool.query(
    `SELECT * FROM expenses
     ${wherePart}
     ORDER BY ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return res.rows;
};

export const count = async (category?: string, month?: string): Promise<number> => {
  const { conditions, params } = buildWhere(category, month);
  const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = await pool.query(`SELECT COUNT(*) FROM expenses ${wherePart}`, params);
  return parseInt(res.rows[0].count, 10);
};

export const totalSpent = async (category?: string, month?: string): Promise<number> => {
  const { conditions, params } = buildWhere(category, month);
  const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = await pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM expenses ${wherePart}`, params);
  return parseFloat(res.rows[0].total) || 0;
};

export const getCategories = async (): Promise<string[]> => {
  const res = await pool.query(`SELECT DISTINCT category FROM expenses WHERE category IS NOT NULL ORDER BY category`);
  return res.rows.map(r => r.category);
};

// Distinct calendar months that have at least one expense — powers the
// month-filter picker so it only ever offers months that actually exist.
export const getMonths = async (): Promise<string[]> => {
  const res = await pool.query(
    `SELECT DISTINCT to_char(expense_date, 'YYYY-MM') AS month FROM expenses ORDER BY month DESC`
  );
  return res.rows.map(r => r.month);
};

// Full matching set, unpaginated — for CSV export, where "give me
// everything that matches" is the point rather than a scrollable page.
// months, if given, restricts to those specific 'YYYY-MM' values (one or
// several); omitted means every month.
export const listForExport = async (category?: string, months?: string[]): Promise<any[]> => {
  const params: any[] = [];
  const conditions: string[] = [];
  if (category) { params.push(category); conditions.push(`category = $${params.length}`); }
  if (months && months.length > 0) { params.push(months); conditions.push(`to_char(expense_date, 'YYYY-MM') = ANY($${params.length})`); }
  const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = await pool.query(
    `SELECT * FROM expenses ${wherePart} ORDER BY expense_date DESC, id DESC`,
    params
  );
  return res.rows;
};

// Rows that actually have a bill attached — for the ZIP-of-bills export.
// months, if given, restricts to those specific 'YYYY-MM' values; omitted
// means "every month with an attachment".
export const listWithAttachments = async (months?: string[]): Promise<any[]> => {
  const params: any[] = [];
  let wherePart = `WHERE attachment_url IS NOT NULL`;
  if (months && months.length > 0) {
    params.push(months);
    wherePart += ` AND to_char(expense_date, 'YYYY-MM') = ANY($${params.length})`;
  }
  const res = await pool.query(
    `SELECT * FROM expenses ${wherePart} ORDER BY expense_date ASC, id ASC`,
    params
  );
  return res.rows;
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
