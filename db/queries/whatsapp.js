import { query } from "../pg.js";

/**
 * Get the stored Yabby group ID
 */
export async function getYabbyGroupId() {
  const result = await query(
    "SELECT yabby_group_id FROM whatsapp_settings ORDER BY id DESC LIMIT 1"
  );
  return result.rows[0]?.yabby_group_id || null;
}

/**
 * Store or update the Yabby group ID
 */
export async function setYabbyGroupId(groupId, groupName = "🤖 Yabby Assistant") {
  const existing = await query("SELECT id FROM whatsapp_settings LIMIT 1");

  if (existing.rows.length > 0) {
    // Update existing
    await query(
      `UPDATE whatsapp_settings
       SET yabby_group_id = $1, yabby_group_name = $2, updated_at = NOW()
       WHERE id = $3`,
      [groupId, groupName, existing.rows[0].id]
    );
  } else {
    // Insert new
    await query(
      `INSERT INTO whatsapp_settings (yabby_group_id, yabby_group_name)
       VALUES ($1, $2)`,
      [groupId, groupName]
    );
  }
}

/**
 * Clear the stored group ID (for reset)
 */
export async function clearYabbyGroupId() {
  await query("DELETE FROM whatsapp_settings");
}
