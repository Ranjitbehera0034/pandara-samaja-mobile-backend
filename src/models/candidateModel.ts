import db from '../config/db';

/* ─────────────── READ ─────────────── */
export const getAll = (): Promise<any> =>
  db.query("SELECT * FROM candidates WHERE is_matched = false AND status = 'approved' ORDER BY name");

export const getAllByGender = (gender: string): Promise<any> =>
  db.query("SELECT * FROM candidates WHERE gender = $1 AND is_matched = false AND status = 'approved' ORDER BY name", [gender]);

export const getById = (id: number | string): Promise<any> =>
  db.query('SELECT * FROM candidates WHERE id = $1', [id]);

/* ─────────────── CREATE ────────────── */
export const createCandidate = (data: any): Promise<any> => {
  const {
    name, gender, dob, age, height, bloodGroup, gotra, bansha, education,
    technicalEducation, professionalEducation, occupation, father, mother,
    address, phone, email, photo
  } = data;

  return db.query(
    `INSERT INTO candidates
      (name, gender, dob, age, height, blood_group, gotra, bansha, education,
       technical_education, professional_education, occupation, father, mother,
       address, phone, email, photo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [name, gender, dob, age, height, bloodGroup, gotra, bansha, education,
      technicalEducation, professionalEducation, occupation, father, mother,
      address, phone, email, photo]
  );
};

/* ─────────────── UPDATE ────────────── */
export const updateCandidate = (id: number | string, data: any): Promise<any> => {
  const {
    name, gender, dob, age, height, bloodGroup, gotra, bansha, education,
    technicalEducation, professionalEducation, occupation, father, mother,
    address, phone, email, photo
  } = data;

  return db.query(
    `UPDATE candidates SET
       name=$1, gender=$2, dob=$3, age=$4, height=$5, blood_group=$6,
       gotra=$7, bansha=$8, education=$9, technical_education=$10,
       professional_education=$11, occupation=$12, father=$13, mother=$14,
       address=$15, phone=$16, email=$17, photo=$18
     WHERE id=$19
     RETURNING *`,
    [name, gender, dob, age, height, bloodGroup, gotra, bansha, education,
      technicalEducation, professionalEducation, occupation, father, mother,
      address, phone, email, photo, id]
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

/* ─────────────── DELETE ────────────── */
export const remove = (id: number | string): Promise<any> =>
  db.query('DELETE FROM candidates WHERE id = $1', [id]);
