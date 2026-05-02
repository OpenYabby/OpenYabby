import { BuiltinConnector } from "./base.js";
import pg from "pg";

export class PostgresConnector extends BuiltinConnector {
  #pool = null;

  _getPool() {
    if (!this.#pool) {
      this.#pool = new pg.Pool({
        connectionString: this.credentials.PG_CONNECTION_STRING,
        max: 3,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });
    }
    return this.#pool;
  }

  getTools() {
    return [
      {
        name: "query",
        description: "Ex\u00e9cuter une requ\u00eate SQL en lecture seule",
        parameters: {
          type: "object",
          properties: {
            sql: { type: "string", description: "Requ\u00eate SQL (SELECT uniquement)" },
            limit: { type: "number", description: "Limite de r\u00e9sultats (d\u00e9faut 50)" },
          },
          required: ["sql"],
        },
      },
      {
        name: "list_tables",
        description: "Lister les tables de la base de donn\u00e9es",
        parameters: {
          type: "object",
          properties: {
            schema: { type: "string", description: "Sch\u00e9ma (d\u00e9faut: public)" },
          },
        },
      },
      {
        name: "describe_table",
        description: "D\u00e9crire les colonnes d'une table",
        parameters: {
          type: "object",
          properties: {
            table: { type: "string", description: "Nom de la table" },
            schema: { type: "string", description: "Sch\u00e9ma (d\u00e9faut: public)" },
          },
          required: ["table"],
        },
      },
    ];
  }

  async executeTool(toolName, args) {
    const pool = this._getPool();

    switch (toolName) {
      case "query": {
        const sql = args.sql.trim();
        // Security: only allow read-only queries
        const forbidden = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)/i;
        if (forbidden.test(sql)) {
          throw new Error("Seules les requ\u00eates SELECT sont autoris\u00e9es");
        }
        const limit = Math.min(args.limit || 50, 200);
        const limitedSql = sql.toLowerCase().includes("limit") ? sql : `${sql} LIMIT ${limit}`;
        const result = await pool.query(limitedSql);
        return JSON.stringify({ rows: result.rows, rowCount: result.rowCount });
      }
      case "list_tables": {
        const schema = args.schema || "public";
        const result = await pool.query(
          "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
          [schema]
        );
        return JSON.stringify(result.rows);
      }
      case "describe_table": {
        const schema = args.schema || "public";
        const result = await pool.query(
          `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2
           ORDER BY ordinal_position`,
          [schema, args.table]
        );
        return JSON.stringify(result.rows);
      }
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  async testCredentials() {
    const pool = this._getPool();
    await pool.query("SELECT 1");
    return true;
  }

  async destroy() {
    if (this.#pool) {
      await this.#pool.end();
      this.#pool = null;
    }
  }
}
