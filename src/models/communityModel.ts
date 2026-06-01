import pool from '../config/db';

// ═══════════════════════════════════════════════════
// COMMUNITY EVENTS
// ═══════════════════════════════════════════════════

export const getEvents = async () => {
    const res = await pool.query(
        `SELECT e.*, COUNT(r.member_id) as rsvp_count, m.name as creator_name
         FROM portal_community_events e
         LEFT JOIN portal_community_event_rsvps r ON e.id = r.event_id
         LEFT JOIN members m ON e.created_by = m.membership_no
         GROUP BY e.id, m.name
         ORDER BY e.event_date ASC`
    );
    return res.rows;
};

export const createEvent = async (title: string, description: string, eventDate: string, location: string, imageUrl: string | null, createdBy: string) => {
    const res = await pool.query(
        `INSERT INTO portal_community_events (title, description, event_date, location, image_url, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [title, description, eventDate, location, imageUrl, createdBy]
    );
    return res.rows[0];
};

export const rsvpEvent = async (eventId: number | string, memberId: string) => {
    await pool.query(
        `INSERT INTO portal_community_event_rsvps (event_id, member_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [eventId, memberId]
    );
};

// ═══════════════════════════════════════════════════
// COMMUNITY GROUPS
// ═══════════════════════════════════════════════════

export const getGroups = async () => {
    const res = await pool.query(
        `SELECT g.*, COUNT(gm.member_id) as member_count
         FROM portal_community_groups g
         LEFT JOIN portal_community_group_members gm ON g.id = gm.group_id
         GROUP BY g.id
         ORDER BY g.created_at DESC`
    );
    return res.rows;
};

export const createGroup = async (name: string, description: string, privacyLevel: string, createdBy: string) => {
    const res = await pool.query(
        `INSERT INTO portal_community_groups (name, description, privacy_level, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [name, description, privacyLevel, createdBy]
    );
    await pool.query(
        `INSERT INTO portal_community_group_members (group_id, member_id, role)
         VALUES ($1, $2, 'admin')`,
        [res.rows[0].id, createdBy]
    );
    return res.rows[0];
};

export const joinGroup = async (groupId: number | string, memberId: string) => {
    const existing = await pool.query(
        `SELECT 1 FROM portal_community_group_members WHERE group_id = $1 AND member_id = $2`,
        [groupId, memberId]
    );

    if (existing.rows.length > 0) {
        // Leave Group
        await pool.query(
            `DELETE FROM portal_community_group_members WHERE group_id = $1 AND member_id = $2`,
            [groupId, memberId]
        );
        return { joined: false };
    } else {
        // Join Group
        await pool.query(
            `INSERT INTO portal_community_group_members (group_id, member_id, role)
             VALUES ($1, $2, 'member')`,
            [groupId, memberId]
        );
        return { joined: true };
    }
};

// ═══════════════════════════════════════════════════
// EXPLORE STATS
// ═══════════════════════════════════════════════════

export const getExploreStats = async () => {
    const memRes = await pool.query(`SELECT COUNT(*) as active_members FROM members WHERE last_portal_login IS NOT NULL`);
    const postRes = await pool.query(`SELECT COUNT(*) as total_posts FROM portal_posts`);
    const groupRes = await pool.query(`SELECT COUNT(*) as total_groups FROM portal_community_groups`);

    return {
        activeMembers: parseInt(memRes.rows[0].active_members) || 0,
        totalPosts: parseInt(postRes.rows[0].total_posts) || 0,
        totalGroups: parseInt(groupRes.rows[0].total_groups) || 0,
        trendingTags: ['#festival', '#community', '#puja']
    };
};

// ═══════════════════════════════════════════════════
// LIVE STREAMS
// ═══════════════════════════════════════════════════

export const getActiveLiveStreams = async () => {
    const res = await pool.query(
        `SELECT l.*, m.name as creator_name 
         FROM portal_live_streams l 
         LEFT JOIN members m ON l.created_by = m.membership_no 
         WHERE is_active = true ORDER BY created_at DESC`
    );
    return res.rows;
};

export const getAllLiveStreams = async () => {
    const res = await pool.query(
        `SELECT l.*, m.name as creator_name 
         FROM portal_live_streams l 
         LEFT JOIN members m ON l.created_by = m.membership_no 
         ORDER BY l.created_at DESC`
    );
    return res.rows;
};

export const createLiveStream = async (title: string, description: string, streamUrl: string, createdBy: string) => {
    const res = await pool.query(
        `INSERT INTO portal_live_streams (title, description, stream_url, created_by, is_active)
         VALUES ($1, $2, $3, $4, true)
         RETURNING *`,
        [title, description, streamUrl, createdBy]
    );
    return res.rows[0];
};

export const updateLiveStreamStatus = async (id: number | string, isActive: boolean) => {
    const query = isActive 
        ? `UPDATE portal_live_streams SET is_active = true, ended_at = NULL WHERE id = $1 RETURNING *`
        : `UPDATE portal_live_streams SET is_active = false, ended_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`;
    const res = await pool.query(query, [id]);
    return res.rows[0];
};

export const deleteLiveStream = async (id: number | string) => {
    await pool.query(`DELETE FROM portal_live_streams WHERE id = $1`, [id]);
};
