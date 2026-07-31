import pool from '../config/db';

export interface StartLiveStreamInput {
  roomName: string;
  hostType: 'member' | 'admin' | 'superadmin';
  hostId: string;
  hostName: string;
  hostPhoto?: string | null;
  title?: string | null;
}

export const startLiveStream = async (input: StartLiveStreamInput) => {
  const res = await pool.query(
    `INSERT INTO live_streams (room_name, host_type, host_id, host_name, host_photo, title)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [input.roomName, input.hostType, input.hostId, input.hostName, input.hostPhoto || null, input.title || null]
  );
  return res.rows[0];
};

// Ends the stream — scoped to the same host who started it, so one
// broadcaster can't end another's stream.
export const endLiveStream = async (roomName: string, hostId: string) => {
  const res = await pool.query(
    `UPDATE live_streams SET ended_at = NOW()
     WHERE room_name = $1 AND host_id = $2 AND ended_at IS NULL
     RETURNING *`,
    [roomName, hostId]
  );
  return res.rows[0] || null;
};

export const getLiveStreamByRoom = async (roomName: string) => {
  const res = await pool.query(
    `SELECT * FROM live_streams WHERE room_name = $1 AND ended_at IS NULL`,
    [roomName]
  );
  return res.rows[0] || null;
};

export const getActiveLiveStreams = async () => {
  const res = await pool.query(
    `SELECT * FROM live_streams WHERE ended_at IS NULL ORDER BY started_at DESC`
  );
  return res.rows;
};

export const bumpPeakViewers = async (roomName: string, currentViewers: number) => {
  await pool.query(
    `UPDATE live_streams SET peak_viewers = GREATEST(peak_viewers, $2) WHERE room_name = $1`,
    [roomName, currentViewers]
  );
};
