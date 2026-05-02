/**
 * channel_containers CRUD — paired host group / server / workspace per
 * channel for the Yabby super-agent's auto-create flow on Telegram /
 * Discord / Slack.
 *
 * One row per channel_name (PK). Pairing replaces any previous row.
 */

import { query } from "../pg.js";

export async function getChannelContainer(channelName) {
  const r = await query(
    `SELECT channel_name, container_id, owner_user_id, owner_user_name,
            paired_by, paired_at, metadata
     FROM channel_containers
     WHERE channel_name = $1`,
    [channelName]
  );
  return r.rows[0] || null;
}

export async function setChannelContainer({ channelName, containerId, ownerUserId, ownerUserName, pairedBy, metadata }) {
  await query(
    `INSERT INTO channel_containers
       (channel_name, container_id, owner_user_id, owner_user_name, paired_by, metadata, paired_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (channel_name) DO UPDATE SET
       container_id    = EXCLUDED.container_id,
       owner_user_id   = EXCLUDED.owner_user_id,
       owner_user_name = EXCLUDED.owner_user_name,
       paired_by       = EXCLUDED.paired_by,
       metadata        = EXCLUDED.metadata,
       paired_at       = NOW()`,
    [channelName, String(containerId), String(ownerUserId), ownerUserName || null, pairedBy || null, JSON.stringify(metadata || {})]
  );
  return getChannelContainer(channelName);
}

export async function clearChannelContainer(channelName) {
  await query(`DELETE FROM channel_containers WHERE channel_name = $1`, [channelName]);
}

export async function listChannelContainers() {
  const r = await query(
    `SELECT channel_name, container_id, owner_user_id, owner_user_name,
            paired_by, paired_at, metadata
     FROM channel_containers
     ORDER BY paired_at DESC`
  );
  return r.rows;
}
