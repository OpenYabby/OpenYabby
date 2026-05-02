import { query } from "../pg.js";

/**
 * Get the WhatsApp group for an agent
 */
export async function getAgentWhatsAppGroup(agentId) {
  const result = await query(
    "SELECT * FROM agent_whatsapp_groups WHERE agent_id = $1",
    [agentId]
  );
  return result.rows[0] || null;
}

/**
 * Get agent by WhatsApp group ID
 */
export async function getAgentByWhatsAppGroup(groupId) {
  const result = await query(
    "SELECT agent_id FROM agent_whatsapp_groups WHERE group_id = $1",
    [groupId]
  );
  return result.rows[0]?.agent_id || null;
}

/**
 * Create or update WhatsApp group for an agent
 */
export async function setAgentWhatsAppGroup(agentId, groupId, groupName) {
  const existing = await getAgentWhatsAppGroup(agentId);

  if (existing) {
    // Update existing
    await query(
      `UPDATE agent_whatsapp_groups
       SET group_id = $1, group_name = $2, updated_at = NOW()
       WHERE agent_id = $3`,
      [groupId, groupName, agentId]
    );
  } else {
    // Insert new
    await query(
      `INSERT INTO agent_whatsapp_groups (agent_id, group_id, group_name)
       VALUES ($1, $2, $3)`,
      [agentId, groupId, groupName]
    );
  }
}

/**
 * Delete WhatsApp group for an agent
 */
export async function deleteAgentWhatsAppGroup(agentId) {
  const result = await query(
    "DELETE FROM agent_whatsapp_groups WHERE agent_id = $1 RETURNING *",
    [agentId]
  );
  return result.rows[0] || null;
}

/**
 * List all agent WhatsApp groups
 */
export async function listAgentWhatsAppGroups() {
  const result = await query(
    "SELECT * FROM agent_whatsapp_groups ORDER BY created_at DESC"
  );
  return result.rows;
}
