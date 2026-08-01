// Shared query functions for laws/articles/search -- extracted from the
// app/api/laws/*, app/api/articles/* route handlers (2026-08-01) so both
// the API routes AND the Server Component pages that render them can call
// the exact same logic directly, without the pages making an HTTP request
// to their own app's API (see plan.md's Decision 1 for the full reasoning).

import { pool } from "./retrieve";
import { INT_TO_UNIT_LABEL, buildCitation } from "./constants";

export interface LawSummary {
  id: string;
  title: string;
  law_number: string;
  law_date: string;
  law_type: string;
  link: string | null;
}

export async function getLaws(): Promise<LawSummary[]> {
  const { rows } = await pool.query(
    "select id, title, law_number, law_date, law_type, link from laws order by title"
  );
  return rows;
}

export async function getLawById(id: string): Promise<LawSummary | null> {
  const { rows } = await pool.query(
    "select id, title, law_number, law_date, law_type, link from laws where id = $1",
    [id]
  );
  return rows[0] ?? null;
}

export interface ArticleSummary {
  id: string;
  unit_type: number;
  unit_number: string;
  chapter: string | null;
  text: string;
  unitTypeLabel: string;
}

// Returns null if the LAW itself doesn't exist (caller returns 404), vs an
// empty array if the law exists but has zero articles ingested yet (caller
// returns 200) -- same distinction the original route logic made.
export async function getArticlesByLawId(lawId: string): Promise<ArticleSummary[] | null> {
  const lawResult = await pool.query("select id from laws where id = $1", [lawId]);
  if (lawResult.rows.length === 0) return null;

  const { rows } = await pool.query(
    "select id, unit_type, unit_number, chapter, text from articles where law_id = $1 order by created_at",
    [lawId]
  );
  return rows.map((r) => ({ ...r, unitTypeLabel: INT_TO_UNIT_LABEL[r.unit_type] }));
}

export interface ArticleDetail {
  id: string;
  unitType: number;
  unitNumber: string;
  chapter: string | null;
  text: string;
  lawId: string;
  lawTitle: string;
  citation: string;
}

export async function getArticleById(id: string): Promise<ArticleDetail | null> {
  const { rows } = await pool.query(
    `select a.id, a.unit_type, a.unit_number, a.chapter, a.text,
            l.id as law_id, l.title as law_title, l.law_number, l.law_type
     from articles a
     join laws l on l.id = a.law_id
     where a.id = $1`,
    [id]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    unitType: row.unit_type,
    unitNumber: row.unit_number,
    chapter: row.chapter,
    text: row.text,
    lawId: row.law_id,
    lawTitle: row.law_title,
    citation: buildCitation(row.unit_type, row.unit_number, row.law_type, row.law_number),
  };
}

export interface SearchResult {
  id: string;
  unitType: number;
  unitNumber: string;
  chapter: string | null;
  text: string;
  lawTitle: string;
  citation: string;
}

export async function searchArticles(q: string): Promise<SearchResult[]> {
  const { rows } = await pool.query(
    `select a.id, a.unit_type, a.unit_number, a.chapter, a.text,
            l.title as law_title, l.law_number, l.law_type
     from articles a
     join laws l on l.id = a.law_id
     where a.text ilike $1
     limit 20`,
    [`%${q}%`]
  );
  return rows.map((row) => ({
    id: row.id,
    unitType: row.unit_type,
    unitNumber: row.unit_number,
    chapter: row.chapter,
    text: row.text,
    lawTitle: row.law_title,
    citation: buildCitation(row.unit_type, row.unit_number, row.law_type, row.law_number),
  }));
}
