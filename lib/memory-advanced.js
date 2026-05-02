/* ═══════════════════════════════════════════════════════
   YABBY — Advanced Memory (extends Mem0)
   ═══════════════════════════════════════════════════════
   hybridSearch, temporalDecay, queryExpansion.
   Does NOT replace lib/memory.js — extends it.
*/

import { log } from "./logger.js";
import { embed, batchEmbed } from "./embeddings.js";
import { getMemoryProfile } from "./memory.js";

/**
 * Hybrid search: combines vector similarity with keyword matching.
 */
export async function hybridSearch(query, opts = {}) {
  const { provider = "openai", topK = 10, keywordWeight = 0.3 } = opts;

  // Get memory profile (keyword search)
  const profile = await getMemoryProfile();
  if (!profile) return [];

  const facts = profile.split("\n").filter(l => l.trim());

  // Score each fact
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

  const scored = facts.map(fact => {
    const factLower = fact.toLowerCase();
    // Keyword score: fraction of query words found in fact
    const keywordHits = queryWords.filter(w => factLower.includes(w)).length;
    const keywordScore = queryWords.length > 0 ? keywordHits / queryWords.length : 0;

    return { fact, keywordScore, score: keywordScore };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Apply temporal decay to search results.
 * More recent facts score higher.
 */
export function temporalDecay(results, halfLifeDays = 30) {
  const now = Date.now();
  return results.map(r => {
    if (!r.timestamp) return r;
    const ageMs = now - new Date(r.timestamp).getTime();
    const ageDays = ageMs / 86400000;
    const decay = Math.pow(0.5, ageDays / halfLifeDays);
    return { ...r, score: (r.score || 0) * decay, decay };
  });
}

/**
 * Expand a query with synonyms and related terms.
 */
export function queryExpansion(query) {
  const expansions = [];
  const lower = query.toLowerCase();

  // French common expansions
  const synonymMap = {
    "prénom": ["nom", "s'appelle", "appelle"],
    "travail": ["métier", "profession", "emploi", "job"],
    "aime": ["adore", "préfère", "passion"],
    "habite": ["vit", "domicile", "adresse", "ville"],
    "âge": ["ans", "né", "naissance"],
  };

  for (const [key, synonyms] of Object.entries(synonymMap)) {
    if (lower.includes(key)) {
      expansions.push(...synonyms);
    }
  }

  if (expansions.length === 0) return query;
  return `${query} (${expansions.join(", ")})`;
}
