import { getKbPool } from "./db";

export type CorpusKey = "legislation" | "legislation2" | "ktp" | "ntc-circolare" | "eurocode";

export type KbDocument = {
  id: string;
  label: string;
  title: string | null;
  status: string | null;
  source_url: string | null;
};

export type KbReference = {
  id: string;
  label: string;
  title: string | null;
  status: string | null;
  source_url: string | null;
  section_label: string | null;
  text: string;
};

export function isCorpusKey(value: string): value is CorpusKey {
  return ["legislation", "legislation2", "ktp", "ntc-circolare", "eurocode"].includes(value);
}

export async function listDocuments(corpus: CorpusKey): Promise<KbDocument[]> {
  const pool = getKbPool();
  if (corpus === "legislation") {
    const { rows } = await pool.query<KbDocument>(`
      select
        id,
        upper(instrument_type) || ' ' || instrument_number as label,
        title,
        legal_status as status,
        source_url
      from legislation_documents
      order by instrument_type, instrument_number, title
    `);
    return rows;
  }

  if (corpus === "legislation2") {
    const { rows } = await pool.query<KbDocument>(`
      select
        d.id,
        upper(d.instrument_type) || ' ' || d.instrument_number as label,
        d.title,
        d.legal_status as status,
        d.source_url
      from legislation_documents d
      join legislation_v2_catalog_documents c on c.document_id = d.id
      where c.include_in_sample = true
      order by d.instrument_type, d.instrument_number, d.title
    `);
    return rows;
  }

  if (corpus === "ktp") {
    const { rows } = await pool.query<KbDocument>(`
      select
        id,
        'KTP ' || coalesce(replace(ktp_number, 'N.', ''), id) as label,
        title,
        status,
        source_url
      from ktp_documents
      order by ktp_number, title
    `);
    return rows;
  }

  if (corpus === "ntc-circolare") {
    const { rows } = await pool.query<KbDocument>(`
      select
        id,
        document || ' ' || coalesce(ntc_version, '') as label,
        title,
        status,
        source_url
      from ntc_documents
      order by document, ntc_version
    `);
    return rows;
  }

  const { rows } = await pool.query<KbDocument>(`
    select
      id,
      coalesce(en_number, id) as label,
      title,
      source_scope as status,
      null::text as source_url
    from eurocode_documents
    order by en_number, title
  `);
  return rows;
}

export async function getReference(corpus: CorpusKey, citationId: string): Promise<KbReference | null> {
  if (corpus === "legislation" || corpus === "legislation2") return getLegislationReference(citationId);
  if (corpus === "ktp") return getKtpReference(citationId);
  if (corpus === "ntc-circolare") return getNtcReference(citationId);
  return getEurocodeReference(citationId);
}

async function getLegislationReference(citationId: string): Promise<KbReference | null> {
  const pool = getKbPool();
  const { rows } = await pool.query<{
    id: string;
    document_id: string;
    section_id: string | null;
    label: string;
    title: string | null;
    status: string | null;
    source_url: string | null;
    section_label: string | null;
    text: string;
  }>(
    `
      with target as (
        select id, document_id, section_id from legislation_paragraphs where id = $1
      )
      select
        t.id,
        t.document_id,
        t.section_id,
        upper(d.instrument_type) || ' ' || d.instrument_number as label,
        d.title,
        d.legal_status as status,
        d.source_url,
        concat_ws(' ', s.level, s.number, s.name) as section_label,
        string_agg(p.text, E'\\n\\n' order by p.chunk_index, p.id) as text
      from target t
      join legislation_documents d on d.id = t.document_id
      left join legislation_sections s on s.id = t.section_id
      join legislation_paragraphs p on p.document_id = t.document_id
        and (p.section_id = t.section_id or (t.section_id is null and p.id = t.id))
      group by t.id, t.document_id, t.section_id, d.instrument_type, d.instrument_number,
        d.title, d.legal_status, d.source_url, s.level, s.number, s.name
    `,
    [citationId],
  );
  return rows[0] ?? null;
}

async function getKtpReference(citationId: string): Promise<KbReference | null> {
  const pool = getKbPool();
  const { rows } = await pool.query<KbReference>(
    `
      with target as (
        select id, document_id, section_id from ktp_paragraphs where id = $1
      )
      select
        t.id,
        'KTP ' || coalesce(replace(d.ktp_number, 'N.', ''), d.id) as label,
        d.title,
        d.status,
        d.source_url,
        concat_ws(' ', s.level, s.number, s.name) as section_label,
        string_agg(p.text, E'\\n\\n' order by p.chunk_index, p.id) as text
      from target t
      join ktp_documents d on d.id = t.document_id
      left join ktp_sections s on s.id = t.section_id
      join ktp_paragraphs p on p.document_id = t.document_id
        and (p.section_id = t.section_id or (t.section_id is null and p.id = t.id))
      group by t.id, d.ktp_number, d.id, d.title, d.status, d.source_url, s.level, s.number, s.name
    `,
    [citationId],
  );
  return rows[0] ?? null;
}

async function getNtcReference(citationId: string): Promise<KbReference | null> {
  const pool = getKbPool();
  const { rows } = await pool.query<KbReference>(
    `
      with target as (
        select id, document_id, section_id from ntc_paragraphs where id = $1
      )
      select
        t.id,
        d.document || ' ' || coalesce(d.ntc_version, '') as label,
        d.title,
        d.status,
        d.source_url,
        concat_ws(' ', 'paragrafo', s.number, s.name) as section_label,
        string_agg(p.text, E'\\n\\n' order by p.chunk_index, p.id) as text
      from target t
      join ntc_documents d on d.id = t.document_id
      left join ntc_sections s on s.id = t.section_id
      join ntc_paragraphs p on p.document_id = t.document_id
        and (p.section_id = t.section_id or (t.section_id is null and p.id = t.id))
      group by t.id, d.document, d.ntc_version, d.title, d.status, d.source_url, s.number, s.name
    `,
    [citationId],
  );
  return rows[0] ?? null;
}

async function getEurocodeReference(citationId: string): Promise<KbReference | null> {
  const pool = getKbPool();
  const { rows } = await pool.query<KbReference>(
    `
      with target as (
        select id, document_id, section_id from eurocode_paragraphs where id = $1
      )
      select
        t.id,
        coalesce(d.en_number, d.id) as label,
        d.title,
        d.source_scope as status,
        null::text as source_url,
        concat_ws(' ', s.level, s.number, s.name) as section_label,
        string_agg(p.text, E'\\n\\n' order by p.chunk_index, p.id) as text
      from target t
      join eurocode_documents d on d.id = t.document_id
      left join eurocode_sections s on s.id = t.section_id
      join eurocode_paragraphs p on p.document_id = t.document_id
        and (p.section_id = t.section_id or (t.section_id is null and p.id = t.id))
      group by t.id, d.en_number, d.id, d.title, d.source_scope, s.level, s.number, s.name
    `,
    [citationId],
  );
  return rows[0] ?? null;
}
