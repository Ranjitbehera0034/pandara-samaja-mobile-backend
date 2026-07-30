import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as expenseModel from '../models/expenseModel';
import { verifyAdmin } from '../middleware/adminAuth';
import { uploadToFirebase, getSignedMediaUrl } from '../utils/firebaseStorage';
import { readMultipartFiles } from '../utils/multipart';
import { logActivity } from '../utils/activityLog';

// Operates on the real, pre-existing `expenses` table (already used by the
// web app) — see src/models/expenseModel.ts for why this isn't the
// `community_expenses` table from migrations/002.
export default async function adminExpensesRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', verifyAdmin);

  // ── GET /api/admin/expenses ── ?category=, paginated + total spent
  fastify.get('/expenses', async (req: FastifyRequest, reply: FastifyReply) => {
    const { page = '1', limit = '20', category } = req.query as any;
    const pPage = parseInt(page, 10) || 1;
    const pLimit = Math.min(parseInt(limit, 10) || 20, 100);

    try {
      const [rows, total, totalSpent, categories] = await Promise.all([
        expenseModel.list({ page: pPage, limit: pLimit, category }),
        expenseModel.count(category),
        expenseModel.totalSpent(),
        expenseModel.getCategories(),
      ]);

      const expenses = await Promise.all(rows.map(async (row: any) => ({
        ...row,
        attachment_url: await getSignedMediaUrl(row.attachment_url),
      })));

      return reply.send({
        success: true,
        expenses,
        total,
        page: pPage,
        totalPages: Math.ceil(total / pLimit),
        totalSpent,
        categories,
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to fetch expenses' });
    }
  });

  // ── POST /api/admin/expenses ── multipart: text fields + optional 'attachment' file
  fastify.post('/expenses', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { files, fields } = await readMultipartFiles(req, ['attachment']);
      const { title, category, amount, description, payee, expenseDate } = fields as any;

      if (!title?.trim() || !category?.trim() || amount === undefined || amount === '' || isNaN(Number(amount))) {
        return reply.status(400).send({ success: false, message: 'title, category, and a numeric amount are required' });
      }

      let attachmentUrl: string | undefined;
      if (files.attachment[0]) {
        attachmentUrl = await uploadToFirebase(files.attachment[0], 'admins/admin/expenses');
      }

      const admin = req.user as any;
      const expense = await expenseModel.create({
        title: title.trim(),
        category: category.trim(),
        amount: Number(amount),
        description: description || null,
        payee: payee || null,
        expenseDate: expenseDate || null,
        attachmentUrl: attachmentUrl || null,
        recordedBy: admin.username,
      });

      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'expense_created',
        targetType: 'expense',
        targetId: String(expense.id),
        metadata: { amount: Number(amount), category: category.trim() },
        req,
      });

      return reply.status(201).send({
        success: true,
        expense: { ...expense, attachment_url: await getSignedMediaUrl(expense.attachment_url) },
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to create expense entry' });
    }
  });

  // ── PUT /api/admin/expenses/:id ── multipart, all fields optional
  fastify.put('/expenses/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const { files, fields } = await readMultipartFiles(req, ['attachment']);
      const { title, category, amount, description, payee, expenseDate } = fields as any;

      if (amount !== undefined && amount !== '' && isNaN(Number(amount))) {
        return reply.status(400).send({ success: false, message: 'amount must be numeric' });
      }

      const data: Record<string, any> = {};
      if (title !== undefined) data.title = title.trim();
      if (category !== undefined) data.category = category.trim();
      if (amount !== undefined && amount !== '') data.amount = Number(amount);
      if (description !== undefined) data.description = description || null;
      if (payee !== undefined) data.payee = payee || null;
      if (expenseDate !== undefined) data.expenseDate = expenseDate || null;
      if (files.attachment[0]) data.attachmentUrl = await uploadToFirebase(files.attachment[0], 'admins/admin/expenses');

      const expense = await expenseModel.update(id, data);
      if (!expense) return reply.status(404).send({ success: false, message: 'Expense entry not found' });

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'expense_updated',
        targetType: 'expense',
        targetId: String(id),
        req,
      });

      return reply.send({
        success: true,
        expense: { ...expense, attachment_url: await getSignedMediaUrl(expense.attachment_url) },
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to update expense entry' });
    }
  });

  // ── DELETE /api/admin/expenses/:id ──
  fastify.delete('/expenses/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as any;
    try {
      const removed = await expenseModel.remove(id);
      if (!removed) return reply.status(404).send({ success: false, message: 'Expense entry not found' });

      const admin = req.user as any;
      await logActivity({
        actorType: admin.role,
        actorId: String(admin.id),
        action: 'expense_deleted',
        targetType: 'expense',
        targetId: String(id),
        req,
      });

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to delete expense entry' });
    }
  });
}
