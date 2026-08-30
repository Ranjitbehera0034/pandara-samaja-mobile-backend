import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import archiver from 'archiver';
import pool from '../config/db';
import { verifyAdmin } from '../middleware/adminAuth';
import { logActivity } from '../utils/activityLog';
import { toCsv } from '../utils/csv';
import * as expenseModel from '../models/expenseModel';
import { resolveFirebasePath, downloadFromFirebase } from '../utils/firebaseStorage';

interface LocationFilters {
  district?: string;
  taluka?: string;
  panchayat?: string;
  village?: string;
}

const buildLocationConditions = (alias: string, startIdx: number, filters: LocationFilters) => {
  const params: any[] = [];
  const conditions: string[] = [];
  let idx = startIdx;
  if (filters.district) { params.push(filters.district); conditions.push(`${alias}.district = $${idx++}`); }
  if (filters.taluka) { params.push(filters.taluka); conditions.push(`${alias}.taluka = $${idx++}`); }
  if (filters.panchayat) { params.push(filters.panchayat); conditions.push(`${alias}.panchayat = $${idx++}`); }
  if (filters.village) { params.push(filters.village); conditions.push(`${alias}.village = $${idx++}`); }
  return { conditions, params };
};

const sendCsv = (reply: FastifyReply, filename: string, csv: string) => {
  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    // Excel/Sheets need a BOM to render UTF-8 (Odia names etc.) correctly.
    .send('﻿' + csv);
};

export default async function adminExportRoutes(fastify: FastifyInstance) {
  // ── GET /api/admin/export/members ──
  fastify.get('/export/members', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const filters = req.query as LocationFilters;
    try {
      const { conditions, params } = buildLocationConditions('m', 1, filters);
      const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const res = await pool.query(
        `SELECT membership_no, name, mobile, head_gender, district, taluka, panchayat, village, address,
                (male + female) AS family_size, is_banned
         FROM members m
         ${wherePart}
         ORDER BY district, taluka, panchayat, village, name`,
        params
      );

      const csv = toCsv(res.rows, [
        { key: 'membership_no', header: 'Membership No' },
        { key: 'name', header: 'Name' },
        { key: 'mobile', header: 'Mobile' },
        { key: 'head_gender', header: 'Gender' },
        { key: 'district', header: 'District' },
        { key: 'taluka', header: 'Taluka' },
        { key: 'panchayat', header: 'Panchayat' },
        { key: 'village', header: 'Village' },
        { key: 'address', header: 'Address' },
        { key: 'family_size', header: 'Family Size' },
        { key: 'is_banned', header: 'Banned' },
      ]);

      const actor = req.user as any;
      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: 'export_members',
        metadata: filters,
        req,
      });

      return sendCsv(reply, 'members.csv', csv);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to export members' });
    }
  });

  // ── GET /api/admin/export/leaders ──
  // Leaders only carry a single free-text `location` field (no structured
  // district/taluka/panchayat/village columns), so any of the four filter
  // params matches against it the same way — whichever one the admin fills
  // in is treated as "find leaders whose location contains this".
  fastify.get('/export/leaders', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const filters = req.query as LocationFilters;
    const locationTerm = filters.village || filters.panchayat || filters.taluka || filters.district;
    try {
      const params: any[] = [];
      let wherePart = '';
      if (locationTerm) {
        params.push(`%${locationTerm}%`);
        wherePart = `WHERE location ILIKE $1`;
      }
      const res = await pool.query(
        `SELECT name, role, level, location
         FROM leaders
         ${wherePart}
         ORDER BY level, location, display_order`,
        params
      );

      const csv = toCsv(res.rows, [
        { key: 'name', header: 'Name' },
        { key: 'role', header: 'Role' },
        { key: 'level', header: 'Level' },
        { key: 'location', header: 'Location' },
      ]);

      const actor = req.user as any;
      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: 'export_leaders',
        metadata: filters,
        req,
      });

      return sendCsv(reply, 'leaders.csv', csv);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to export leaders' });
    }
  });

  // ── GET /api/admin/export/matrimony ──
  fastify.get('/export/matrimony', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const filters = req.query as LocationFilters;
    try {
      const { conditions, params } = buildLocationConditions('m', 1, filters);
      const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const res = await pool.query(
        `SELECT a.membership_no, a.member_name, a.relation_to_hof, a.member_mobile, a.status,
                a.submitted_at, m.district, m.taluka, m.panchayat, m.village
         FROM matrimony_applications a
         JOIN members m ON m.membership_no = a.membership_no
         ${wherePart}
         ORDER BY m.district, m.taluka, m.panchayat, m.village, a.member_name`,
        params
      );

      const csv = toCsv(res.rows, [
        { key: 'membership_no', header: 'Membership No' },
        { key: 'member_name', header: 'Name' },
        { key: 'relation_to_hof', header: 'Relation to HOF' },
        { key: 'member_mobile', header: 'Mobile' },
        { key: 'status', header: 'Status' },
        { key: 'submitted_at', header: 'Submitted At' },
        { key: 'district', header: 'District' },
        { key: 'taluka', header: 'Taluka' },
        { key: 'panchayat', header: 'Panchayat' },
        { key: 'village', header: 'Village' },
      ]);

      const actor = req.user as any;
      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: 'export_matrimony',
        metadata: filters,
        req,
      });

      return sendCsv(reply, 'matrimony_candidates.csv', csv);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to export matrimony candidates' });
    }
  });

  // months query param is a comma-separated list of 'YYYY-MM' values,
  // shared by both expense export routes below. Omitted/empty means "every
  // month" — that's the "export everything at once" case.
  const parseMonths = (raw: any): string[] | undefined => {
    if (!raw || typeof raw !== 'string') return undefined;
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return list.length > 0 ? list : undefined;
  };

  // ── GET /api/admin/export/expenses ── CSV of expense records, optionally
  // restricted to one or more months and/or a category.
  fastify.get('/export/expenses', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { months: monthsRaw, category } = req.query as any;
    const months = parseMonths(monthsRaw);
    try {
      const rows = await expenseModel.listForExport(category, months);
      // toCsv has no per-column formatter — precompute a plain Yes/No field
      // instead of exporting the raw signed/proxy URL, which expires or is
      // meaningless outside the app anyway.
      const rowsForCsv = rows.map((r) => ({ ...r, has_attachment: r.attachment_url ? 'Yes' : 'No' }));

      const csv = toCsv(rowsForCsv, [
        { key: 'expense_date', header: 'Date' },
        { key: 'title', header: 'Title' },
        { key: 'category', header: 'Category' },
        { key: 'amount', header: 'Amount (INR)' },
        { key: 'payee', header: 'Payee' },
        { key: 'description', header: 'Description' },
        { key: 'recorded_by', header: 'Recorded By' },
        { key: 'has_attachment', header: 'Has Attachment' },
      ]);

      const actor = req.user as any;
      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: 'export_expenses',
        metadata: { months: months || 'all', category: category || null },
        req,
      });

      return sendCsv(reply, 'expenses.csv', csv);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ success: false, message: 'Failed to export expenses' });
    }
  });

  // ── GET /api/admin/export/expenses-bills ── ZIP of the actual attached
  // bill files, one folder per month, optionally restricted to specific
  // months. Rows with no attachment are silently skipped — nothing to zip.
  fastify.get('/export/expenses-bills', { preHandler: verifyAdmin }, async (req: FastifyRequest, reply: FastifyReply) => {
    const months = parseMonths((req.query as any).months);
    try {
      const rows = await expenseModel.listWithAttachments(months);
      if (rows.length === 0) {
        return reply.status(404).send({ success: false, message: 'No bills with an attachment found for the selected month(s)' });
      }

      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', 'attachment; filename="expense-bills.zip"');

      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', (err: Error) => fastify.log.error(err, '[EXPORT] ZIP stream error'));
      reply.send(archive);

      const usedNames = new Set<string>();
      for (const row of rows) {
        const filePath = resolveFirebasePath(row.attachment_url);
        if (!filePath) continue;
        try {
          const buffer = await downloadFromFirebase(filePath);
          const month = new Date(row.expense_date).toISOString().slice(0, 7);
          const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '';
          const safeTitle = String(row.title || 'expense').replace(/[^a-zA-Z0-9_-]/g, '_');
          let name = `${month}/${safeTitle}_${row.id}${ext}`;
          // Extremely unlikely collision guard — same month+title+id can't
          // actually repeat since id is unique, but keep it airtight anyway.
          while (usedNames.has(name)) name = `${month}/${safeTitle}_${row.id}_${Math.random().toString(36).slice(2, 6)}${ext}`;
          usedNames.add(name);
          archive.append(buffer, { name });
        } catch (err: any) {
          fastify.log.warn(`[EXPORT] Skipping attachment for expense ${row.id}: ${err?.message || err}`);
        }
      }

      const actor = req.user as any;
      await logActivity({
        actorType: actor.role === 'superadmin' ? 'superadmin' : 'admin',
        actorId: String(actor.id),
        action: 'export_expenses_bills',
        metadata: { months: months || 'all', count: rows.length },
        req,
      });

      await archive.finalize();
    } catch (err) {
      fastify.log.error(err);
      if (!reply.sent) {
        return reply.status(500).send({ success: false, message: 'Failed to export bills' });
      }
    }
  });
}
