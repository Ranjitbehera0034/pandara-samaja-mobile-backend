// One-off backfill: derive expires_at for job_postings rows that predate
// the auto-derive logic in jobModel.ts (create/updatePosting only compute
// it going forward, on write). Without this, existing published jobs won't
// get the deadline-reminder push or the auto-hide-after-deadline behavior
// until an admin happens to edit them. Safe to re-run — only ever touches
// rows where expires_at IS NULL, never overwrites an admin-set value.
//
// Usage: npx tsx scripts/backfillJobExpiry.ts        (dry run, no writes)
//        npx tsx scripts/backfillJobExpiry.ts --apply (writes)
import pool from '../src/config/db';
import { parseLastDateToExpiry } from '../src/utils/lastDateParse';

async function main() {
  const apply = process.argv.includes('--apply');

  const { rows } = await pool.query(
    `SELECT id, title, last_date FROM job_postings WHERE expires_at IS NULL ORDER BY id`
  );

  console.log(`${rows.length} job_postings row(s) with no expires_at.`);
  const toUpdate: { id: number; expiresAt: string; title: string; lastDate: string }[] = [];

  for (const row of rows) {
    const derived = parseLastDateToExpiry(row.last_date);
    if (derived) {
      toUpdate.push({ id: row.id, expiresAt: derived.toISOString(), title: row.title, lastDate: row.last_date });
    }
  }

  console.log(`${toUpdate.length} of those have a parseable last_date:`);
  for (const r of toUpdate) {
    console.log(`  #${r.id} "${r.title}" — last_date="${r.lastDate}" -> expires_at=${r.expiresAt}`);
  }

  if (!apply) {
    console.log('\nDry run only — no rows written. Re-run with --apply to write these.');
    await pool.end();
    return;
  }

  await pool.query('BEGIN');
  try {
    for (const r of toUpdate) {
      await pool.query('UPDATE job_postings SET expires_at = $1 WHERE id = $2', [r.expiresAt, r.id]);
    }
    const verify = await pool.query(
      `SELECT COUNT(*) FROM job_postings WHERE expires_at IS NOT NULL`
    );
    console.log('Rows with expires_at set after update:', verify.rows[0].count);
    await pool.query('COMMIT');
    console.log(`Committed: ${toUpdate.length} row(s) updated.`);
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Rolled back due to error:', err);
    throw err;
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
