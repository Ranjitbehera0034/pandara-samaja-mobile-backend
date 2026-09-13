import pool from '../config/db';

/**
 * Model for the Song Competition — admin launches a contest, members
 * register (solo or as a group, one group per village) and upload a
 * performance video, admin approves before it's publicly visible for
 * liking/commenting. See ARCHITECTURE.md's "Song Competition" section.
 */

const CONTEST_COLUMNS = `id, title, description, rules, status, started_at, closed_at, created_at`;
const ENTRY_COLUMNS = `id, contest_id, entry_type, entry_name, village, participant_names,
  registered_by_membership_no, registered_by_mobile, video_url, moderation_status,
  admin_remarks, reviewed_by, reviewed_at, created_at`;

/* ─────────────── CONTESTS ────────────── */

export const listContests = (): Promise<any> =>
  pool.query(`SELECT ${CONTEST_COLUMNS} FROM song_contests ORDER BY created_at DESC`);

// Member-facing — only ever a draft contest is hidden; active/closed are
// both visible (closed just means registration shut, entries still show).
export const listVisibleContests = (): Promise<any> =>
  pool.query(`SELECT ${CONTEST_COLUMNS} FROM song_contests WHERE status != 'draft' ORDER BY created_at DESC`);

export const getContestById = (id: number | string): Promise<any> =>
  pool.query(`SELECT ${CONTEST_COLUMNS} FROM song_contests WHERE id = $1`, [id]);

interface CreateContestInput {
  title: string;
  description?: string | null;
  rules?: string | null;
}

export const createContest = (data: CreateContestInput): Promise<any> =>
  pool.query(
    `INSERT INTO song_contests (title, description, rules, status, created_at)
     VALUES ($1, $2, $3, 'draft', NOW())
     RETURNING ${CONTEST_COLUMNS}`,
    [data.title, data.description || null, data.rules || null]
  );

export const updateContest = async (id: number | string, data: Partial<CreateContestInput>): Promise<any> => {
  const existing = await getContestById(id);
  const row = existing.rows[0];
  if (!row) return { rows: [] };

  const merged = {
    title: data.title ?? row.title,
    description: data.description !== undefined ? data.description : row.description,
    rules: data.rules !== undefined ? data.rules : row.rules,
  };

  return pool.query(
    `UPDATE song_contests SET title = $1, description = $2, rules = $3
     WHERE id = $4
     RETURNING ${CONTEST_COLUMNS}`,
    [merged.title, merged.description, merged.rules, id]
  );
};

// draft -> active: the only "start" transition. Members can't see or
// register for a contest until this happens.
export const startContest = (id: number | string): Promise<any> =>
  pool.query(
    `UPDATE song_contests SET status = 'active', started_at = NOW() WHERE id = $1 AND status = 'draft'
     RETURNING ${CONTEST_COLUMNS}`,
    [id]
  );

// active -> closed: registration/upload shuts, entries stay visible for
// likes/comments/judging.
export const closeContest = (id: number | string): Promise<any> =>
  pool.query(
    `UPDATE song_contests SET status = 'closed', closed_at = NOW() WHERE id = $1 AND status = 'active'
     RETURNING ${CONTEST_COLUMNS}`,
    [id]
  );

export const deleteContest = (id: number | string): Promise<any> =>
  pool.query('DELETE FROM song_contests WHERE id = $1 RETURNING id', [id]);

/* ─────────────── ENTRIES ────────────── */

export const listApprovedEntries = (contestId: number | string): Promise<any> =>
  pool.query(
    `SELECT e.*, COALESCE(l.like_count, 0) AS like_count, COALESCE(c.comment_count, 0) AS comment_count
     FROM song_contest_entries e
     LEFT JOIN (SELECT entry_id, COUNT(*) AS like_count FROM song_contest_likes GROUP BY entry_id) l ON l.entry_id = e.id
     LEFT JOIN (SELECT entry_id, COUNT(*) AS comment_count FROM song_contest_comments GROUP BY entry_id) c ON c.entry_id = e.id
     WHERE e.contest_id = $1 AND e.moderation_status = 'approved'
     ORDER BY like_count DESC, e.created_at ASC`,
    [contestId]
  );

export const getEntryById = (id: number | string): Promise<any> =>
  pool.query(`SELECT ${ENTRY_COLUMNS} FROM song_contest_entries WHERE id = $1`, [id]);

interface CreateEntryInput {
  contestId: number | string;
  entryType: 'individual' | 'group';
  entryName: string;
  village?: string | null;
  participantNames?: string | null;
  registeredByMembershipNo: string;
  registeredByMobile: string;
  videoUrl: string;
}

export const createEntry = (data: CreateEntryInput): Promise<any> =>
  pool.query(
    `INSERT INTO song_contest_entries
      (contest_id, entry_type, entry_name, village, participant_names,
       registered_by_membership_no, registered_by_mobile, video_url, moderation_status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',NOW())
     RETURNING ${ENTRY_COLUMNS}`,
    [
      data.contestId, data.entryType, data.entryName, data.village || null,
      data.participantNames || null, data.registeredByMembershipNo, data.registeredByMobile,
      data.videoUrl,
    ]
  );

export const getMyEntry = (contestId: number | string, membershipNo: string, mobile: string): Promise<any> =>
  pool.query(
    `SELECT ${ENTRY_COLUMNS} FROM song_contest_entries
     WHERE contest_id = $1 AND registered_by_membership_no = $2 AND registered_by_mobile = $3
       AND moderation_status != 'rejected'`,
    [contestId, membershipNo, mobile]
  );

/* ─────────────── ADMIN — MODERATION ────────────── */

export const adminListEntries = (contestId: number | string, status?: string): Promise<any> => {
  const params: any[] = [contestId];
  let where = 'contest_id = $1';
  if (status) {
    params.push(status);
    where += ` AND moderation_status = $${params.length}`;
  }
  return pool.query(
    `SELECT ${ENTRY_COLUMNS} FROM song_contest_entries WHERE ${where} ORDER BY created_at ASC`,
    params
  );
};

export const approveEntry = (id: number | string, reviewedBy: string): Promise<any> =>
  pool.query(
    `UPDATE song_contest_entries
     SET moderation_status = 'approved', reviewed_by = $1, reviewed_at = NOW()
     WHERE id = $2
     RETURNING ${ENTRY_COLUMNS}`,
    [reviewedBy, id]
  );

export const rejectEntry = (id: number | string, reviewedBy: string, remark: string): Promise<any> =>
  pool.query(
    `UPDATE song_contest_entries
     SET moderation_status = 'rejected', admin_remarks = $1, reviewed_by = $2, reviewed_at = NOW()
     WHERE id = $3
     RETURNING ${ENTRY_COLUMNS}`,
    [remark, reviewedBy, id]
  );

/* ─────────────── LIKES ────────────── */

export const likeEntry = (entryId: number | string, membershipNo: string, mobile: string): Promise<any> =>
  pool.query(
    `INSERT INTO song_contest_likes (entry_id, membership_no, mobile)
     VALUES ($1, $2, $3)
     ON CONFLICT (entry_id, membership_no, mobile) DO NOTHING`,
    [entryId, membershipNo, mobile]
  );

export const unlikeEntry = (entryId: number | string, membershipNo: string, mobile: string): Promise<any> =>
  pool.query(
    `DELETE FROM song_contest_likes WHERE entry_id = $1 AND membership_no = $2 AND mobile = $3`,
    [entryId, membershipNo, mobile]
  );

export const hasLiked = async (entryId: number | string, membershipNo: string, mobile: string): Promise<boolean> => {
  const res = await pool.query(
    `SELECT 1 FROM song_contest_likes WHERE entry_id = $1 AND membership_no = $2 AND mobile = $3`,
    [entryId, membershipNo, mobile]
  );
  return (res.rowCount ?? 0) > 0;
};

// Which of this contest's entries the given person has liked — used to
// render each entry's "liked by me" state in one query rather than one
// per entry.
export const getLikedEntryIds = async (contestId: number | string, membershipNo: string, mobile: string): Promise<Set<number>> => {
  const res = await pool.query(
    `SELECT l.entry_id FROM song_contest_likes l
     JOIN song_contest_entries e ON e.id = l.entry_id
     WHERE e.contest_id = $1 AND l.membership_no = $2 AND l.mobile = $3`,
    [contestId, membershipNo, mobile]
  );
  return new Set(res.rows.map((r: any) => r.entry_id));
};

/* ─────────────── COMMENTS ────────────── */

export const addComment = (entryId: number | string, membershipNo: string, mobile: string, content: string): Promise<any> =>
  pool.query(
    `INSERT INTO song_contest_comments (entry_id, membership_no, mobile, content, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING *`,
    [entryId, membershipNo, mobile, content]
  );

export const getComments = (entryId: number | string): Promise<any> =>
  pool.query(
    `SELECT c.*, m.name AS author_name
     FROM song_contest_comments c
     JOIN members m ON m.membership_no = c.membership_no
     WHERE c.entry_id = $1
     ORDER BY c.created_at ASC`,
    [entryId]
  );
