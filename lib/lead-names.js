/* ═══════════════════════════════════════════════════════
   YABBY — Lead Agent Name Generator
   ═══════════════════════════════════════════════════════

   Generates random human first names for auto-created lead agents.
   Lead agents must have real first names (not titles like "Directeur Général").
*/

import OpenAI from "openai";

const LEAD_NAMES = [
  // French
  "Alice", "Antoine", "Camille", "Charlotte", "Claire", "Emma", "Hugo", "Jade",
  "Jules", "Léa", "Louis", "Louise", "Lucas", "Manon", "Marie", "Mathis",
  "Nathan", "Nicolas", "Paul", "Sophie", "Thomas", "Victor",

  // English
  "Alexander", "Benjamin", "David", "Emily", "Emma", "Ethan", "Isabella", "James",
  "John", "Liam", "Michael", "Noah", "Olivia", "Robert", "Sarah", "William",

  // Spanish
  "Alejandro", "Carlos", "Daniel", "Elena", "Gabriel", "Isabel", "Javier", "Laura",
  "Manuel", "Maria", "Miguel", "Sofia",

  // German
  "Anna", "Felix", "Hannah", "Jonas", "Julia", "Leon", "Lena", "Lukas",
  "Maximilian", "Mia", "Paul", "Sarah"
];

/**
 * Generate a random first name for a lead agent
 * @returns {string} A random human first name
 */
export function generateLeadName() {
  return LEAD_NAMES[Math.floor(Math.random() * LEAD_NAMES.length)];
}

/**
 * Check if a name is a valid human first name using GPT-4o-mini
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function isValidLeadName(name) {
  if (!name || typeof name !== 'string') return false;
  const normalized = name.trim();

  // Quick check against known list first (fast path)
  if (LEAD_NAMES.includes(normalized)) return true;

  // Use GPT-4o-mini for validation
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a name validator. Respond ONLY with 'YES' if the input is a real human first name (not a title, role, or phrase), or 'NO' otherwise."
        },
        {
          role: "user",
          content: normalized
        }
      ],
      temperature: 0,
      max_tokens: 5
    });

    const answer = response.choices[0]?.message?.content?.trim().toUpperCase();
    return answer === "YES";
  } catch (err) {
    console.error(`[LEAD-NAMES] Validation error for "${name}":`, err.message);
    // Fallback: reject if not in known list
    return false;
  }
}
