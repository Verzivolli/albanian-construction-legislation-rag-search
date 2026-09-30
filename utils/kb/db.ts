// Demo replacement for KodiAI's utils/kb/db.ts. The real app queries Supabase Postgres; the
// demo runs the SAME SQL on PGlite (Postgres compiled to WebAssembly, inside this function),
// loaded from a read-only export of the three KTP tables (data/ktp-export.json). No external
// database, nothing to pause, and nothing can be written back anywhere.
import { PGlite } from "@electric-sql/pglite";
import exported from "../../data/ktp-export.json";

type Column = { column_name: string; udt_name: string };
type Table = { columns: Column[]; primaryKey: string[]; rows: Record<string, unknown>[] };
const TABLES = exported.tables as unknown as Record<string, Table>;
const SQL_TYPE: Record<string, string> = { text: "text", int4: "integer", bool: "boolean", date: "date", timestamptz: "timestamptz", _text: "text[]" };

let ready: Promise<PGlite> | undefined;

async function load(): Promise<PGlite> {
  const db = await PGlite.create();
  await db.transaction(async (tx) => {
    for (const [name, t] of Object.entries(TABLES)) {
      const cols = t.columns.map((c) => `"${c.column_name}" ${SQL_TYPE[c.udt_name] ?? "text"}`);
      const pk = t.primaryKey.length ? `, primary key (${t.primaryKey.map((c) => `"${c}"`).join(", ")})` : "";
      await tx.exec(`create table ${name} (${cols.join(", ")}${pk});`);
      const names = t.columns.map((c) => c.column_name);
      // jsonb_populate_recordset turns one JSON array into typed rows: one statement per table.
      await tx.query(
        `insert into ${name} (${names.map((n) => `"${n}"`).join(", ")})
         select ${names.map((n) => `"${n}"`).join(", ")} from jsonb_populate_recordset(null::${name}, $1::jsonb)`,
        [JSON.stringify(t.rows)],
      );
    }
  });
  return db;
}

/** Same surface as the pg Pool the pipeline uses: only query(text, params) -> { rows }. */
export function getKbPool() {
  return {
    async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
      ready ??= load();
      const db = await ready;
      const res = await db.query<T>(text, params as unknown[] | undefined);
      return { rows: res.rows };
    },
  };
}
