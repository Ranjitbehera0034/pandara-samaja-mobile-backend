import db from '../config/db';

/* ─────────────── READ / BROWSE ─────────────── */

interface BrowseFilters {
  viewerMembershipNo: string;
  genderNotEqual?: string; // browse candidates of the opposite gender by default
  search?: string;
  minAge?: number;
  maxAge?: number;
  education?: string;
  gotra?: string;
  sort?: 'newest' | 'age_asc' | 'age_desc' | 'name';
  limit?: number;
  offset?: number;
}

export const browse = (filters: BrowseFilters): Promise<any> => {
  const params: any[] = [filters.viewerMembershipNo];
  const conditions = [
    'is_matched = false',
    "status = 'approved'",
    // Don't show the viewer their own submitted profile(s), and hide
    // anything they've already swiped on.
    'submitted_by IS DISTINCT FROM $1',
    `NOT EXISTS (SELECT 1 FROM portal_matrimony_interests i WHERE i.candidate_id = candidates.id AND i.member_id = $1)`,
  ];

  if (filters.genderNotEqual) {
    params.push(filters.genderNotEqual);
    conditions.push(`gender != $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const idx = params.length;
    conditions.push(`(LOWER(name) LIKE LOWER($${idx}) OR LOWER(gotra) LIKE LOWER($${idx}) OR LOWER(occupation) LIKE LOWER($${idx}) OR LOWER(education) LIKE LOWER($${idx}))`);
  }
  if (filters.minAge !== undefined) {
    params.push(filters.minAge);
    conditions.push(`age >= $${params.length}`);
  }
  if (filters.maxAge !== undefined) {
    params.push(filters.maxAge);
    conditions.push(`age <= $${params.length}`);
  }
  if (filters.education) {
    params.push(`%${filters.education}%`);
    conditions.push(`LOWER(education) LIKE LOWER($${params.length})`);
  }
  if (filters.gotra) {
    params.push(filters.gotra);
    conditions.push(`gotra = $${params.length}`);
  }

  const sortMap: Record<string, string> = {
    newest: 'created_at DESC',
    age_asc: 'age ASC',
    age_desc: 'age DESC',
    name: 'name ASC',
  };
  const orderBy = sortMap[filters.sort || 'newest'] || sortMap.newest;

  const limit = Math.min(filters.limit ?? 20, 50);
  const offset = filters.offset ?? 0;
  params.push(limit, offset);

  return db.query(
    `SELECT * FROM candidates
     WHERE ${conditions.join(' AND ')}
     ORDER BY ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
};

export const getById = (id: number | string): Promise<any> =>
  db.query('SELECT * FROM candidates WHERE id = $1', [id]);

export const getBySubmitter = (membershipNo: string): Promise<any> =>
  db.query('SELECT * FROM candidates WHERE submitted_by = $1 ORDER BY created_at DESC', [membershipNo]);

/* ─────────────── CREATE / UPDATE (self-service) ────────────── */

export const createCandidate = (data: any): Promise<any> => {
  const {
    name, gender, dob, age, height, bloodGroup, gotra, bansha, education,
    technicalEducation, professionalEducation, occupation, father, mother,
    address, phone, email, photo, photos, formUrl, submittedBy
  } = data;

  return db.query(
    `INSERT INTO candidates
      (name, gender, dob, age, height, blood_group, gotra, bansha, education,
       technical_education, professional_education, occupation, father, mother,
       address, phone, email, photo, photos, form_url, submitted_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'approved')
     RETURNING *`,
    [name, gender, dob, age, height, bloodGroup, gotra, bansha, education,
      technicalEducation, professionalEducation, occupation, father, mother,
      address, phone, email, photo || null, photos || [], formUrl || null, submittedBy]
  );
};

export const updateCandidate = (id: number | string, data: any): Promise<any> => {
  const {
    name, gender, dob, age, height, bloodGroup, gotra, bansha, education,
    technicalEducation, professionalEducation, occupation, father, mother,
    address, phone, email, photo, photos, formUrl
  } = data;

  return db.query(
    `UPDATE candidates SET
       name=$1, gender=$2, dob=$3, age=$4, height=$5, blood_group=$6,
       gotra=$7, bansha=$8, education=$9, technical_education=$10,
       professional_education=$11, occupation=$12, father=$13, mother=$14,
       address=$15, phone=$16, email=$17,
       photo=COALESCE($18, photo), photos=COALESCE($19, photos), form_url=COALESCE($20, form_url)
     WHERE id=$21
     RETURNING *`,
    [name, gender, dob, age, height, bloodGroup, gotra, bansha, education,
      technicalEducation, professionalEducation, occupation, father, mother,
      address, phone, email, photo || null, photos || null, formUrl || null, id]
  );
};

export const markMatched = (id: number | string, partnerName: string, partnerGender: string): Promise<any> => {
  return db.query(
    `UPDATE candidates
     SET is_matched = true, matched_partner_name = $1, matched_partner_gender = $2
     WHERE id = $3
     RETURNING *`,
    [partnerName, partnerGender, id]
  );
};

export const remove = (id: number | string): Promise<any> =>
  db.query('DELETE FROM candidates WHERE id = $1', [id]);

/* ─────────────── SWIPE / INTEREST TRACKING ────────────── */

// Records a like/pass and, on 'like', checks whether it's a mutual match:
// the viewer's own submitted candidate must have also been liked by
// someone from the target candidate's submitting member.
export const recordSwipe = async (
  memberId: string,
  candidateId: number | string,
  direction: 'like' | 'pass'
): Promise<{ matched: boolean }> => {
  await db.query(
    `INSERT INTO portal_matrimony_interests (candidate_id, member_id, direction)
     VALUES ($1, $2, $3)
     ON CONFLICT (candidate_id, member_id) DO UPDATE SET direction = $3, created_at = NOW()`,
    [candidateId, memberId, direction]
  );

  if (direction !== 'like') return { matched: false };

  // Who submitted the candidate the viewer just liked?
  const targetRes = await db.query('SELECT submitted_by FROM candidates WHERE id = $1', [candidateId]);
  const targetOwner = targetRes.rows[0]?.submitted_by;
  if (!targetOwner) return { matched: false };

  // Did that owner's own candidate profile(s) already like one of the
  // viewer's submitted candidate profiles?
  const mutualRes = await db.query(
    `SELECT 1
     FROM portal_matrimony_interests i
     JOIN candidates viewerCandidate ON viewerCandidate.id = i.candidate_id
     WHERE i.member_id = $1 AND i.direction = 'like' AND viewerCandidate.submitted_by = $2
     LIMIT 1`,
    [targetOwner, memberId]
  );
  return { matched: mutualRes.rows.length > 0 };
};

// A mutual match: I liked `target` (submitted by some other member), AND
// that member separately liked one of my own submitted candidate profiles.
export const getMatches = (memberId: string): Promise<any> =>
  db.query(
    `SELECT DISTINCT target.*
     FROM portal_matrimony_interests myLikes
     JOIN candidates target ON target.id = myLikes.candidate_id
     JOIN candidates myCandidate ON myCandidate.submitted_by = $1
     JOIN portal_matrimony_interests theirLikes
       ON theirLikes.candidate_id = myCandidate.id
       AND theirLikes.member_id = target.submitted_by
       AND theirLikes.direction = 'like'
     WHERE myLikes.member_id = $1 AND myLikes.direction = 'like'
     ORDER BY target.created_at DESC`,
    [memberId]
  );
