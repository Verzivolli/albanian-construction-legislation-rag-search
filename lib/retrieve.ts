// Retrieval: given a question, find the most relevant articles and return
// their REAL text + a human-readable citation. TypeScript port of
// python-etl/retrieve.py.
//
// Same two-step design as the Python version: Pinecone tells us WHICH
// articles are relevant (it embeds the query itself, server-side, via
// integrated inference), but we deliberately ignore whatever text Pinecone
// hands back and re-fetch the real text from Postgres instead -- Postgres
// is the source of truth, avoids Pinecone's copy going stale after an
// article edit (see plan.md's Step 6 decision, made when the Python
// version was built).

import { Pool } from "pg";
import { Pinecone } from "@pinecone-database/pinecone";
import { INT_TO_UNIT_LABEL } from "./constants";

// A connection POOL, not a single connection like Python's psycopg2.connect().
// Next.js API routes run as short-lived serverless functions -- opening a
// brand-new Postgres connection on every request doesn't scale the way it's
// fine to in a one-off script. A pool keeps a small set of connections open
// and reuses them across requests.
//
// Exported (not just module-private) so chat.ts can reuse this exact same
// pool for chat_messages queries, instead of opening a second one -- one
// pool shared across the whole app, not one per file (decided 2026-07-27).
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
// pc.index({ name: ... }) is the current (non-deprecated) way to target an
// index by name -- confirmed against the installed SDK's own type
// definitions, since the bare-string form `pc.index('name')` is marked
// @deprecated and scheduled for removal in the SDK's next major version.
const index = pc.index({ name: process.env.PINECONE_INDEX! });

// Exported (not just a private interface) so generate.ts can type its own
// `hits` parameter against exactly what retrieve() actually returns.
export interface RetrievalHit {
  id: string; // the article's real Postgres id -- needed so the UI can
  // fetch GET /api/articles/:id when a citation is clicked (2026-08-01,
  // right-panel reference viewer -- see plan.md).
  score: number;
  citation: string;
  lawTitle: string;
  text: string;
}

export async function retrieve(
  queryText: string,
  topK: number = 5,
  namespace: string = "pilot",
  // Optional search-scope filter (2026-08-01, left-sidebar toggle
  // feature) -- when provided, only articles belonging to one of these
  // law ids are considered. Uses Pinecone's own metadata filter, keyed on
  // `law_id`, which python-etl/ingest_pilot.py has stored on every
  // legislation vector since the pilot was first built specifically for
  // this feature (see that file's own comment, found already in place).
  lawIds?: string[]
): Promise<RetrievalHit[]> {
  // Step 1: ask Pinecone which articles are most relevant. Only requesting
  // unit_type/unit_number back -- NOT text, since we don't trust Pinecone's
  // stored copy of it (see module docstring above).
  const results = await index.namespace(namespace).searchRecords({
    query: {
      inputs: { text: queryText },
      topK,
      // $in: Pinecone's Mongo-style metadata filter operator -- "law_id
      // must be one of these values". Omitted entirely (not an empty
      // filter object) when no scope is chosen, so an unfiltered search
      // behaves exactly as it always has.
      ...(lawIds && lawIds.length > 0 ? { filter: { law_id: { $in: lawIds } } } : {}),
    },
    fields: ["unit_type", "unit_number"],
  });

  // NOTE: this SDK's Hit type uses `_id`/`_score` (WITH underscore) --
  // confirmed against the installed package's own Hit.d.ts. This is the
  // OPPOSITE of the Python SDK's response object, which uses `.id`/`.score`
  // (no underscore) after the fix made when retrieve.py was first built.
  // Different SDKs, different convention -- checked rather than assumed.
  const hits = results.result.hits;
  const hitIds = hits.map((hit) => hit._id);
  const scoresById = new Map(hits.map((hit) => [hit._id, hit._score]));

  if (hitIds.length === 0) return []; // no matches -- caller decides what to do

  // Step 2: fetch the real text + law info for exactly those ids, in one
  // query (not one query per hit). $1::uuid[] is pg's parameter syntax
  // (Python's psycopg2 used %s) -- same explicit uuid[] cast as the Python
  // version needed, since Postgres won't auto-compare a uuid column
  // against a plain text array.
  const { rows } = await pool.query(
    `select a.id, a.unit_type, a.unit_number, a.text,
            l.law_number, l.law_type, l.title
     from articles a
     join laws l on l.id = a.law_id
     where a.id = any($1::uuid[])`,
    [hitIds]
  );
  const rowsById = new Map(rows.map((r) => [r.id, r]));

  // Step 3: SQL doesn't promise to return rows in the order we asked for
  // them -- rebuild the list in Pinecone's original relevance order, same
  // reason as the Python version (most relevant match should stay first).
  return hitIds.map((id) => {
    const row = rowsById.get(id)!;
    const lawTypeCapitalized = row.law_type[0].toUpperCase() + row.law_type.slice(1);
    return {
      id,
      score: scoresById.get(id)!,
      citation: `${INT_TO_UNIT_LABEL[row.unit_type]} ${row.unit_number}, ${lawTypeCapitalized} ${row.law_number}`,
      lawTitle: row.title,
      text: row.text,
    };
  });
}
