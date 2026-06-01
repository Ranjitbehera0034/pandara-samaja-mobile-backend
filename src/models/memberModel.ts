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
    "SELECT * FROM members WHERE (LOWER(name) LIKE LOWER($1) OR mobile LIKE $1 OR membership_no LIKE $1) ORDER BY name LIMIT $2 OFFSET $3",
    [q, limit, offset]
  );
  res.rows.forEach(r => {
    if (r.aadhar_no) r.aadhar_no = decrypt(r.aadhar_no);
  });
  return res;
};

export const getMemberFilterOptions = async (): Promise<any> => {
  const query = `
        SELECT DISTINCT district, taluka, panchayat
        FROM members
        WHERE (is_banned IS NULL OR is_banned = false)
          AND district IS NOT NULL AND TRIM(district) != ''
        ORDER BY district, taluka, panchayat
    `;
  const res = await pool.query(query);

  const districts = new Set<string>();
  const talukas: { [key: string]: Set<string> } = {};
  const panchayats: { [key: string]: Set<string> } = {};

  res.rows.forEach(row => {
    const d = row.district?.trim();
    const t = row.taluka?.trim();
    const p = row.panchayat?.trim();

    if (d) {
      districts.add(d);
      if (t) {
        if (!talukas[d]) talukas[d] = new Set<string>();
        talukas[d].add(t);

        if (p) {
          if (!panchayats[t]) panchayats[t] = new Set<string>();
          panchayats[t].add(p);
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
    panchayats: serializeSet(panchayats)
  };
};

export const getFiltered = async (limit = 20, offset = 0, filters: any = {}): Promise<any> => {
  const params: any[] = [];
  const conditions: string[] = [];

  if (filters.search) {
    params.push(`%${filters.search}%`);
    const idx = params.length;
    conditions.push(`(LOWER(name) LIKE LOWER($${idx}) OR mobile LIKE $${idx} OR membership_no LIKE $${idx})`);
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
    conditions.push(`(LOWER(name) LIKE LOWER($${idx}) OR mobile LIKE $${idx} OR membership_no LIKE $${idx})`);
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

export const getDemographicsStats = async (filters: any = {}): Promise<any> => {
  const { district, taluka, panchayat } = filters;
  const params: any[] = [];
  let conditions = ["(is_banned IS NULL OR is_banned = false)"];

  if (district) {
    params.push(district);
    conditions.push(`district = $${params.length}`);
  }
  if (taluka) {
    params.push(taluka);
    conditions.push(`taluka = $${params.length}`);
  }
  if (panchayat) {
    params.push(panchayat);
    conditions.push(`panchayat = $${params.length}`);
  }

  const wherePart = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const query = `
    SELECT 
      COALESCE(SUM(male), 0) as total_male,
      COALESCE(SUM(female), 0) as total_female,
      COALESCE(SUM(CASE WHEN created_at >= CURRENT_DATE THEN male ELSE 0 END), 0) as male_today,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('week', CURRENT_DATE) THEN male ELSE 0 END), 0) as male_week,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('month', CURRENT_DATE) THEN male ELSE 0 END), 0) as male_month,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('year', CURRENT_DATE) THEN male ELSE 0 END), 0) as male_year,
      COALESCE(SUM(CASE WHEN created_at >= CURRENT_DATE THEN female ELSE 0 END), 0) as female_today,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('week', CURRENT_DATE) THEN female ELSE 0 END), 0) as female_week,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('month', CURRENT_DATE) THEN female ELSE 0 END), 0) as female_month,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('year', CURRENT_DATE) THEN female ELSE 0 END), 0) as female_year
    FROM members
    ${wherePart}
  `;
  try {
    const res = await pool.query(query, params);
    return res.rows[0];
  } catch (error: any) {
    console.error('Demographics Stats Query Error:', error.message);
    if (error.code === '42703') {
      const basicRes = await pool.query(`SELECT COALESCE(SUM(male), 0) as total_male, COALESCE(SUM(female), 0) as total_female FROM members ${wherePart}`, params);
      return {
        ...basicRes.rows[0],
        male_today: 0, male_week: 0, male_month: 0, male_year: 0,
        female_today: 0, female_week: 0, female_month: 0, female_year: 0
      };
    }
    throw error;
  }
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

export const remove = async (id: string): Promise<boolean> => {
  await pool.query("DELETE FROM members WHERE membership_no = $1", [id]);
  return true;
};

export const exportExcel = async (stream: any): Promise<void> => {
  throw new Error('exportExcel is stubbed in the mobile backend');
};

export const bulkUpsertMembers = async (rows: any[]): Promise<number> => {
  throw new Error('bulkUpsertMembers is stubbed in the mobile backend');
};
