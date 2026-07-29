import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as expenseModel from '../models/expenseModel';
import { verifyAdmin } from '../middleware/adminAuth';
import { logActivity } from '../utils/activityLog';

// community_expenses is a brand-new table (see
// migrations/002_admin_dashboard_expansion.sql) — every handler here is
// 42P01-safe via expenseModel's `{ ok, ... }` result shape.
export default async function adminExpensesRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyAdmin);

  // ── GET /api/admin/expenses ── ?type=income|expense, paginated + summary
  fastify.get('/expenses', async (req: FastifyRequest, reply: FastifyReply) => {
    const { page = '1', limit = '20', type } = req.query as any;
    const pPage = parseInt(page, 10) || 1;
    const pLimit = Math.min(parseInt(limit, 10) || 20, 100);
    const normalizedType = type === 'income' || type === 'expense' ? type : undefined;

    try {
      const [listResult, countResult, summaryResult] = await Promise.all([
        expenseModel.list({ page: pPage, limit: pLimit, type: normalizedType }),
        expenseModel.count(normalizedType),
        expenseModel.summary(),
      ]);

      if (!listResult.ok) {
        return reply.send({
          success: true,
          expenses: [],
          total: 0,
          page: pPage,
          totalPages: 0,
          summary: { totalIncome: 0, totalExpense: 0, balance: 0 },
          migrationPending: true,
        });
      }

      return reply.send({
        success: true,
        expenses: listResult.rows,
        total: countResult.total,
        page: pPage,
        totalPages: Math.ceil(countResult.total / pLimit),
        summary: {
          totalIncome: summaryResult.totalIncome,
          totalExpense: summaryResult.totalExpense,
          balance: summaryResult.balance,
        },
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch expenses' });
    }
  });

  // ── POST /api/admin/expenses ──
  fastify.post('/expenses', async (req: FastifyRequest, reply: FastifyReply) => {
    const { title, type, amount, category, note, entryDate } = req.body as any;
    if (!title?.trim() || !['income', 'expense'].includes(type) || amount === undefined || amount === null || isNaN(Number(amount))) {
      return reply.status(400).send({ success: false, message: 'title, type ("income"|"expense"), and a numeric amount are required' });
    }

    const admin = req.user as any;
    try {
      const result = await expenseModel.create({
        title: title.trim(),
        type,
        amount: Number(amount),
        category,
        note,
        entryDate,
        createdBy: admin.id,
      });

      if (!result.ok) {
        return reply.status(503).send({ success: false, message: 'Community expenses feature is pending migration' });
      }

      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'expense_created',
        targetType: 'expense',
        targetId: String(result.row.id),
        metadata: { type, amount: Number(amount) },
        req,
      });

      return reply.status(201).send({ success: true, expense: result.row });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to create expense entry' });
    }
  });

  // ── PUT /api/admin/expenses/:id ──
  fastify.put('/expenses/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    const { title, type, amount, category, note, entryDate } = req.body as any;

    if (type !== undefined && !['income', 'expense'].includes(type)) {
      return reply.status(400).send({ success: false, message: 'type must be "income" or "expense"' });
    }

    try {
      const result = await expenseModel.update(id, {
        title: title !== undefined ? title.trim() : undefined,
        type,
        amount: amount !== undefined ? Number(amount) : undefined,
        category,
        note,
        entryDate,
      });

      if (!result.ok) {
        return reply.status(503).send({ success: false, message: 'Community expenses feature is pending migration' });
      }
      if (!result.row) return reply.status(404).send({ success: false, message: 'Expense entry not found' });

      return reply.send({ success: true, expense: result.row });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update expense entry' });
    }
  });

  // ── DELETE /api/admin/expenses/:id ──
  fastify.delete('/expenses/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const result = await expenseModel.remove(id);
      if (!result.ok) {
        return reply.status(503).send({ success: false, message: 'Community expenses feature is pending migration' });
      }
      if (!result.row) return reply.status(404).send({ success: false, message: 'Expense entry not found' });
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to delete expense entry' });
    }
  });
}
