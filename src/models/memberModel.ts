import pool from '../config/db';
import { encrypt, decrypt } from '../utils/encryption';

const generateMembershipNo = async (): Promise<string> => {
  let membershipNo = '';
  let exists = true;

  while (exists) {
    const randomNum = Math.floor(1000000 + Math.random() * 9000000);
    membershipNo = `MEM${randomNum}`;

    const result = await pool.query(
      "SELECT 1 FROM members WHERE membership_no = $1",
      [membershipNo]
    );
    exists = result.rows.length > 0;
  }

  return membershipNo;
};

export const create = async (data: any): Promise<any> => {
  const toIntOrNull = (val: any) => {
    if (val === null || val === undefined || val === '') return null;
    const n = Number(val);
    return isNaN(n) ? null : n;
  };

  const membershipNo = data.membership_no?.trim() || await generateMembershipNo();

  let familyMembers = data.family_members ?? [];
  if (typeof familyMembers === 'string') {
    try { familyMembers = JSON.parse(familyMembers); } catch { familyMembers = []; }
  }

  const params = [
    membershipNo,
    data.name ?? null,
    data.head_gender ?? null,
    data.mobile ?? null,
    toIntOrNull(data.male),
    toIntOrNull(data.female),
    data.district ?? null,
    data.taluka ?? null,
    data.panchayat ?? null,
    data.village ?? null,
    encrypt(data.aadhar_no) ?? null,
    JSON.stringify(familyMembers),
    data.address ?? null,
    data.state ?? null,
    data.profile_photo_url ?? null
  ];

  const query = `
    INSERT INTO members (membership_no, name, head_gender, mobile, male, female, district, taluka, panchayat, village, aadhar_no, family_members, address, state, profile_photo_url)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15)
    RETURNING *`;

  const res = await pool.query(query, params);
  return res.rows[0];
};

export const getAll = async (limit = 20, offset = 0): Promise<any> => {
  const query = "SELECT * FROM members ORDER BY district, taluka, panchayat, name LIMIT $1 OFFSET $2";
  const res = await pool.query(query, [limit, offset]);
  res.rows.forEach(r => {
    if (r.aadhar_no) r.aadhar_no = decrypt(r.aadhar_no);
  });
  return res;
};

export const getTotalCount = async (): Promise<number> => {
  const res = await pool.query("SELECT COUNT(*) FROM members");
  return parseInt(res.rows[0].count, 10);
};

export const getAllByLocation = async (district: string, taluka: string, panchayat: string): Promise<any> => {
  return pool.query(
    "SELECT * FROM members WHERE district=$1 AND taluka=$2 AND panchayat=$3",
    [district, taluka, panchayat]
  );
};

export const search = async (keyword: string, limit = 20, offset = 0): Promise<any> => {
  const q = `%${keyword}%`;
  const res = await pool.query(
    "SELECT * FROM members WHERE (LOWER(name) LIKE LOWER($1) OR mobile LIKE $1 OR membership_no LIKE $1 OR LOWER(village) LIKE LOWER($1)) ORDER BY name LIMIT $2 OFFSET $3",
    [q, limit, offset]
  );
  res.rows.forEach(r => {
    if (r.aadhar_no) r.aadhar_no = decrypt(r.aadhar_no);
  });
  return res;
};

// Person-level search for chat: matches the household head OR any individual
// family member who has their own registered mobile number (chat is
// per-person, and only someone with their own login mobile can be messaged
// directly — a family member with no mobile on file has no chat identity).
// Returns one row per PERSON, not per household.
export const searchChatPeople = async (
  keyword: string, excludeMembershipNo: string, excludeMobile: string, limit = 20, offset = 0
): Promise<any[]> => {
  const q = `%${keyword}%`;
  const res = await pool.query(
    `SELECT * FROM (
       SELECT m.membership_no, m.mobile AS person_mobile, m.name AS person_name,
              'Head' AS relation, m.profile_photo_url AS avatar, m.village
       FROM members m
       WHERE m.mobile IS NOT NULL AND m.mobile != ''
         AND (LOWER(m.name) LIKE LOWER($1) OR m.mobile LIKE $1 OR m.membership_no LIKE $1)

       UNION ALL

       SELECT m.membership_no, fm->>'mobile' AS person_mobile, fm->>'name' AS person_name,
              fm->>'relation' AS relation, fm->>'profile_pic' AS avatar, m.village
       FROM members m, jsonb_array_elements(
              CASE WHEN jsonb_typeof(m.family_members) = 'array' THEN m.family_members ELSE '[]'::jsonb END
            ) AS fm
       WHERE fm->>'mobile' IS NOT NULL AND fm->>'mobile' != ''
         AND (LOWER(fm->>'name') LIKE LOWER($1) OR fm->>'mobile' LIKE $1)
     ) people
     WHERE NOT (membership_no = $4 AND person_mobile = $5)
     ORDER BY person_name
     LIMIT $2 OFFSET $3`,
    [q, limit, offset, excludeMembershipNo, excludeMobile]
  );
  return res.rows;
};

export const getMemberFilterOptions = async (): Promise<any> => {
  const query = `
        SELECT DISTINCT district, taluka, panchayat, village
        FROM members
        WHERE (is_banned IS NULL OR is_banned = false)
          AND district IS NOT NULL AND TRIM(district) != ''
        ORDER BY district, taluka, panchayat, village
    `;
  const res = await pool.query(query);

  const districts = new Set<string>();
  const talukas: { [key: string]: Set<string> } = {};
  const panchayats: { [key: string]: Set<string> } = {};
  const villages: { [key: string]: Set<string> } = {};

  res.rows.forEach(row => {
    const d = row.district?.trim();
    const t = row.taluka?.trim();
    const p = row.panchayat?.trim();
    const v = row.village?.trim();

    if (d) {
      districts.add(d);
      if (t) {
        if (!talukas[d]) talukas[d] = new Set<string>();
        talukas[d].add(t);

        if (p) {
          if (!panchayats[t]) panchayats[t] = new Set<string>();
          panchayats[t].add(p);

          if (v) {
            if (!villages[p]) villages[p] = new Set<string>();
            villages[p].add(v);
          }
        }
      }
    }
  });

  const serializeSet = (obj: { [key: string]: Set<string> }) => {
    const result: { [key: string]: string[] } = {};
    for (const [key, set] of Object.entries(obj)) {
      result[key] = Array.from(set).sort();
    }
    return result;
  };

  return {
    districts: Array.from(districts).sort(),
    talukas: serializeSet(talukas),
    panchayats: serializeSet(panchayats),
    villages: serializeSet(villages)
  };
};

export const getFiltered = async (limit = 20, offset = 0, filters: any = {}): Promise<any> => {
  const params: any[] = [];
  const conditions: string[] = [];

  if (filters.search) {
    params.push(`%${filters.search}%`);
    const idx = params.length;
    conditions.push(`(LOWER(name) LIKE LOWER($${idx}) OR mobile LIKE $${idx} OR membership_no LIKE $${idx} OR LOWER(village) LIKE LOWER($${idx}))`);
  }
  if (filters.district) {
    params.push(filters.district);
    conditions.push(`district = $${params.length}`);
  }
  if (filters.taluka) {
    params.push(filters.taluka);
    conditions.push(`taluka = $${params.length}`);
  }
  if (filters.panchayat) {
    params.push(filters.panchayat);
    conditions.push(`panchayat = $${params.length}`);
  }
  if (filters.village) {
    params.push(filters.village);
    conditions.push(`village = $${params.length}`);
  }
  if (filters.gender === 'female') {
    conditions.push(`LOWER(head_gender) IN ('female', 'f')`);
  } else if (filters.gender === 'male') {
    conditions.push(`LOWER(head_gender) NOT IN ('female', 'f')`);
  }
  if (filters.has_photo === 'true') {
    conditions.push(`COALESCE(trim(profile_photo_url), '') != ''`);
  } else if (filters.has_photo === 'false') {
    conditions.push(`COALESCE(trim(profile_photo_url), '') = ''`);
  }
  if (filters.has_aadhar === 'true') {
    conditions.push(`COALESCE(trim(aadhar_no), '') != ''`);
  } else if (filters.has_aadhar === 'false') {
    conditions.push(`COALESCE(trim(aadhar_no), '') = ''`);
  }
  if (filters.marital_status) {
    params.push(filters.marital_status);
    conditions.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(family_members) = 'array' THEN family_members ELSE '[]'::jsonb END) as fm WHERE fm->>'marital_status' = $${params.length})`);
  }
  if (filters.eligible_for_marriage === 'true') {
    conditions.push(`EXISTS (
      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(family_members) = 'array' THEN family_members ELSE '[]'::jsonb END) as fm 
      WHERE fm->>'marital_status' = 'Unmarried' 
      AND fm->>'age' ~ '^[0-9]+$' 
      AND (
        (LOWER(fm->>'gender') = 'female' AND CAST(fm->>'age' AS INTEGER) >= 18) OR 
        (LOWER(fm->>'gender') != 'female' AND CAST(fm->>'age' AS INTEGER) >= 21)
      )
    )`);
  }
  if (filters.children_count !== undefined && filters.children_count !== '') {
    params.push(parseInt(filters.children_count, 10));
    conditions.push(`(SELECT COUNT(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(family_members) = 'array' THEN family_members ELSE '[]'::jsonb END) as fm WHERE LOWER(fm->>'relation') IN ('son', 'daughter')) = $${params.length}`);
  }

  const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const query = `SELECT * FROM members ${wherePart} ORDER BY district, taluka, panchayat, name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

  params.push(limit, offset);

  const res = await pool.query(query, params);
  res.rows.forEach(r => {
    if (r.aadhar_no) r.aadhar_no = decrypt(r.aadhar_no);
  });
  return res;
};

export const getFilteredCount = async (filters: any = {}): Promise<number> => {
  const params: any[] = [];
  const conditions: string[] = [];

  if (filters.search) {
    params.push(`%${filters.search}%`);
    const idx = params.length;
    conditions.push(`(LOWER(name) LIKE LOWER($${idx}) OR mobile LIKE $${idx} OR membership_no LIKE $${idx} OR LOWER(village) LIKE LOWER($${idx}))`);
  }
  if (filters.district) {
    params.push(filters.district);
    conditions.push(`district = $${params.length}`);
  }
  if (filters.taluka) {
    params.push(filters.taluka);
    conditions.push(`taluka = $${params.length}`);
  }
  if (filters.panchayat) {
    params.push(filters.panchayat);
    conditions.push(`panchayat = $${params.length}`);
  }
  if (filters.village) {
    params.push(filters.village);
    conditions.push(`village = $${params.length}`);
  }
  if (filters.gender === 'female') {
    conditions.push(`LOWER(head_gender) IN ('female', 'f')`);
  } else if (filters.gender === 'male') {
    conditions.push(`LOWER(head_gender) NOT IN ('female', 'f')`);
  }
  if (filters.has_photo === 'true') {
    conditions.push(`COALESCE(trim(profile_photo_url), '') != ''`);
  } else if (filters.has_photo === 'false') {
    conditions.push(`COALESCE(trim(profile_photo_url), '') = ''`);
  }
  if (filters.has_aadhar === 'true') {
    conditions.push(`COALESCE(trim(aadhar_no), '') != ''`);
  } else if (filters.has_aadhar === 'false') {
    conditions.push(`COALESCE(trim(aadhar_no), '') = ''`);
  }
  if (filters.marital_status) {
    params.push(filters.marital_status);
    conditions.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(family_members) = 'array' THEN family_members ELSE '[]'::jsonb END) as fm WHERE fm->>'marital_status' = $${params.length})`);
  }
  if (filters.eligible_for_marriage === 'true') {
    conditions.push(`EXISTS (
      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(family_members) = 'array' THEN family_members ELSE '[]'::jsonb END) as fm 
      WHERE fm->>'marital_status' = 'Unmarried' 
      AND fm->>'age' ~ '^[0-9]+$' 
      AND (
        (LOWER(fm->>'gender') = 'female' AND CAST(fm->>'age' AS INTEGER) >= 18) OR 
        (LOWER(fm->>'gender') != 'female' AND CAST(fm->>'age' AS INTEGER) >= 21)
      )
    )`);
  }
  if (filters.children_count !== undefined && filters.children_count !== '') {
    params.push(parseInt(filters.children_count, 10));
    conditions.push(`(SELECT COUNT(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(family_members) = 'array' THEN family_members ELSE '[]'::jsonb END) as fm WHERE LOWER(fm->>'relation') IN ('son', 'daughter')) = $${params.length}`);
  }

  const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = await pool.query(`SELECT COUNT(*) FROM members ${wherePart}`, params);
  return parseInt(res.rows[0].count, 10);
};

export const getDemographics = async (): Promise<{
  totalFamilyMembers: number; male: number; female: number;
  adults: number; children: number; infants: number;
  married: number; unmarried: number;
  householdsTotal: number; householdsWithDetailedData: number;
}> => {
  // Two different data sources, deliberately not conflated:
  //  - members.male/female are household-level headcounts captured at
  //    registration for EVERY household (6,789 of them) — reliable for the
  //    real community total and overall gender split.
  //  - family_members is a newer, opt-in, per-person JSONB roster (name/
  //    age/gender/marital_status) that only ~1.6% of households have ever
  //    filled in. It's the only source with age/marital-status detail, so
  //    adults/children/infants/married/unmarried can only be computed from
  //    that much smaller, self-selected slice — NOT representative of the
  //    whole community, unlike the total/male/female figures above.
  const totalsQuery = `
    SELECT
      COUNT(*) AS households_total,
      COALESCE(SUM(male), 0) + COALESCE(SUM(female), 0) AS total,
      COALESCE(SUM(male), 0) AS male,
      COALESCE(SUM(female), 0) AS female
    FROM members
    WHERE (is_banned IS NULL OR is_banned = false)
  `;
  const detailQuery = `
    SELECT
      COUNT(DISTINCT m.membership_no) AS households_with_detail,
      COUNT(*) FILTER (WHERE fm->>'age' ~ '^[0-9]+$' AND (fm->>'age')::int >= 18) AS adults,
      COUNT(*) FILTER (WHERE fm->>'age' ~ '^[0-9]+$' AND (fm->>'age')::int >= 2 AND (fm->>'age')::int < 18) AS children,
      COUNT(*) FILTER (WHERE fm->>'age' ~ '^[0-9]+$' AND (fm->>'age')::int < 2) AS infants,
      COUNT(*) FILTER (WHERE LOWER(fm->>'marital_status') = 'married') AS married,
      COUNT(*) FILTER (WHERE LOWER(fm->>'marital_status') = 'unmarried') AS unmarried
    FROM members m,
         jsonb_array_elements(CASE WHEN jsonb_typeof(m.family_members) = 'array' THEN m.family_members ELSE '[]'::jsonb END) AS fm
    WHERE (m.is_banned IS NULL OR m.is_banned = false)
  `;
  const [totalsRes, detailRes] = await Promise.all([pool.query(totalsQuery), pool.query(detailQuery)]);
  const totals = totalsRes.rows[0];
  const detail = detailRes.rows[0];
  return {
    totalFamilyMembers: parseInt(totals.total, 10),
    male: parseInt(totals.male, 10), female: parseInt(totals.female, 10),
    adults: parseInt(detail.adults, 10), children: parseInt(detail.children, 10), infants: parseInt(detail.infants, 10),
    married: parseInt(detail.married, 10), unmarried: parseInt(detail.unmarried, 10),
    householdsTotal: parseInt(totals.households_total, 10),
    householdsWithDetailedData: parseInt(detail.households_with_detail, 10),
  };
};

export const getOne = async (id: string): Promise<any> => {
  const res = await pool.query("SELECT * FROM members WHERE membership_no = $1", [id]);
  const member = res.rows[0];
  if (member && member.aadhar_no) {
    member.aadhar_no = decrypt(member.aadhar_no);
  }
  return member || null;
};

export const update = async (id: string, data: any): Promise<any> => {
  const existing = await getOne(id);
  if (!existing) return null;

  const toIntOrNull = (val: any) => {
    if (val === null || val === undefined || val === '') return null;
    const n = Number(val);
    return isNaN(n) ? null : n;
  };

  const merged = { ...existing, ...data };
  const p_male = toIntOrNull(merged.male);
  const p_female = toIntOrNull(merged.female);

  let familyMembers = merged.family_members ?? [];
  if (typeof familyMembers === 'string') {
    try { familyMembers = JSON.parse(familyMembers); } catch { familyMembers = []; }
  }

  const params = [
    merged.name ?? null,
    merged.head_gender ?? null,
    merged.mobile ?? null,
    p_male,
    p_female,
    merged.district ?? null,
    merged.taluka ?? null,
    merged.panchayat ?? null,
    merged.village ?? null,
    encrypt(merged.aadhar_no) ?? null,
    JSON.stringify(familyMembers),
    merged.address ?? null,
    merged.state ?? null,
    merged.profile_photo_url ?? null,
    id
  ];

  const query = `
    UPDATE members 
    SET name=$1, head_gender=$2, mobile=$3, male=$4, female=$5, district=$6, taluka=$7, panchayat=$8, village=$9,
        aadhar_no=$10, family_members=$11::jsonb, address=$12, state=$13, profile_photo_url=$14
    WHERE membership_no=$15 RETURNING *`;

  const res = await pool.query(query, params);
  return res.rows[0];
};

// Shared parse helper — mirrors the try/parse-or-default pattern already
// used inline in getOne/update/create in this file and in routes/members.ts.
function parseFamilyMembers(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

function isHeadEntry(entry: any): boolean {
  const r = (entry?.relation || '').toLowerCase();
  return r === 'self' || r === 'self/head' || r === 'head';
}

export const getFamilyMembers = async (membershipNo: string): Promise<any[] | null> => {
  const member = await getOne(membershipNo);
  if (!member) return null;
  return parseFamilyMembers(member.family_members);
};

// Family-member reads/writes must be serialized per household: two family
// members concurrently self-editing (e.g. two people uploading a profile
// photo from different phones at the same moment) both read the same
// snapshot of `family_members`, then each write their own modified copy
// back — the second write silently discards the first's change (a lost
// update). `SELECT ... FOR UPDATE` inside a transaction locks the row for
// the duration of the read-modify-write cycle so a concurrent call blocks
// until the first one commits, instead of working from a stale snapshot.
// This intentionally writes ONLY the family_members column (not the
// generic update() full-row merge) so it can't collide with concurrent
// edits to other member fields either.
const withFamilyMembersLock = async <T>(
  membershipNo: string,
  mutate: (familyMembers: any[]) => T | null
): Promise<T | null> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      'SELECT family_members FROM members WHERE membership_no = $1 FOR UPDATE',
      [membershipNo]
    );
    if (!res.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const familyMembers = parseFamilyMembers(res.rows[0].family_members);
    const result = mutate(familyMembers);
    if (result === null) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(
      'UPDATE members SET family_members = $1::jsonb WHERE membership_no = $2',
      [JSON.stringify(familyMembers), membershipNo]
    );
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

export const addFamilyMember = async (membershipNo: string, data: any): Promise<any[] | null> => {
  return withFamilyMembersLock(membershipNo, (familyMembers) => {
    const entry = {
      name: data.name, relation: data.relation, gender: data.gender || null,
      age: data.age !== undefined ? String(data.age) : '',
      marital_status: data.marital_status || '', profile_pic: data.profile_pic || null,
      mobile: data.mobile || null,
    };
    if (isHeadEntry(entry)) throw new Error('A household can only have one head of family entry');
    familyMembers.push(entry);
    return familyMembers;
  });
};

export const updateFamilyMember = async (membershipNo: string, index: number, data: any): Promise<any[] | null> => {
  return withFamilyMembersLock(membershipNo, (familyMembers) => {
    if (index < 0 || index >= familyMembers.length) return null;
    const existing = familyMembers[index];
    if (isHeadEntry(existing) && data.relation && !isHeadEntry({ relation: data.relation })) {
      throw new Error('Cannot change the head of family\'s own relation');
    }
    familyMembers[index] = {
      ...existing,
      name: data.name !== undefined ? data.name : existing.name,
      relation: data.relation !== undefined ? data.relation : existing.relation,
      gender: data.gender !== undefined ? data.gender : existing.gender,
      age: data.age !== undefined ? String(data.age) : existing.age,
      marital_status: data.marital_status !== undefined ? data.marital_status : existing.marital_status,
      profile_pic: data.profile_pic !== undefined ? data.profile_pic : existing.profile_pic,
      mobile: data.mobile !== undefined ? data.mobile : existing.mobile,
    };
    return familyMembers;
  });
};

export const removeFamilyMember = async (membershipNo: string, index: number): Promise<any[] | null> => {
  return withFamilyMembersLock(membershipNo, (familyMembers) => {
    if (index < 0 || index >= familyMembers.length) return null;
    if (isHeadEntry(familyMembers[index])) throw new Error('Cannot remove the head of family');
    familyMembers.splice(index, 1);
    return familyMembers;
  });
};

export const remove = async (id: string): Promise<boolean> => {
  await pool.query("DELETE FROM members WHERE membership_no = $1", [id]);
  return true;
};

export const setBanned = async (id: string, banned: boolean): Promise<any> => {
  const res = await pool.query(
    'UPDATE members SET is_banned = $1 WHERE membership_no = $2 RETURNING membership_no, name, is_banned',
    [banned, id]
  );
  return res.rows[0] || null;
};

export const exportExcel = async (stream: any): Promise<void> => {
  throw new Error('exportExcel is stubbed in the mobile backend');
};

export const bulkUpsertMembers = async (rows: any[]): Promise<number> => {
  throw new Error('bulkUpsertMembers is stubbed in the mobile backend');
};
