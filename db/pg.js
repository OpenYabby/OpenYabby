import pg from "pg";
const { Pool, types } = pg;

// BIGINT (OID 20) defaults to string in node-postgres because 64-bit ints
// exceed JS Number.MAX_SAFE_INTEGER. We only store media.size_bytes as
// BIGINT and never exceed 50 MB in practice, so integer parsing is safe.
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

const pool = new Pool({
  host:     process.env.PG_HOST || "localhost",
  port:     parseInt(process.env.PG_PORT || "5432"),
  database: process.env.PG_DATABASE || "yabby",
  user:     process.env.PG_USER || "yabby",
  password: process.env.PG_PASSWORD || "",
  max:      10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("[PG] Unexpected pool error:", err.message);
});

export default pool;
export const query = (text, params) => pool.query(text, params);
