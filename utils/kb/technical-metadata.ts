import { getKbPool } from "./db";
import { applyKtpRerankRules, ktpPointFromId, type KtpRuleOptions } from "./ktp-topic-rules";

export type KtpChunk = {
  id: string;
  document_id: string;
  section_id: string | null;
  ktp_number: string | null;
  title: string | null;
  status: string | null;
  last_verified: string | null;
  section_level: string | null;
  section_number: string | null;
  section_name: string | null;
  source_file: string | null;
  has_image: boolean;
  text: string;
  context_text: string | null;
  block_type: string | null;
  parent_point_title: string | null;
  topic_label: string | null;
  figure_files: string[] | null;
  score?: number;
  retrieval_source?: string;
};

export type NtcChunk = {
  id: string;
  document_id: string;
  document: "NTC" | "Circolare";
  title: string | null;
  status: string | null;
  last_verified: string | null;
  section_level: string | null;
  section_number: string | null;
  section_name: string | null;
  capitolo: string | null;
  capitolo_title: string | null;
  ntc_version: string | null;
  source_file: string | null;
  has_image: boolean;
  text: string;
  score?: number;
  retrieval_source?: string;
};

export type EurocodeChunk = {
  id: string;
  source_vector_id: string | null;
  document_id: string;
  en_number: string | null;
  title: string | null;
  section_level: string | null;
  section_number: string | null;
  section_name: string | null;
  clause_number: string | null;
  parent_clause: string | null;
  chunk_type: string;
  is_procedural: boolean;
  has_table: boolean;
  has_formula: boolean;
  has_note: boolean;
  text: string;
  score?: number;
  retrieval_source?: string;
};

const KTP_CHUNKS_BY_ID_QUERY = `
  select
    p.id, p.document_id, p.section_id, d.ktp_number, d.title, d.status, d.last_verified,
    s.level as section_level, s.number as section_number, s.name as section_name,
    p.source_file, p.has_image, p.text,
    p.context_text, p.block_type, p.parent_point_title, p.topic_label, p.figure_files
  from ktp_paragraphs p
  join ktp_documents d on d.id = p.document_id
  left join ktp_sections s on s.id = p.section_id
  where p.id = any($1::text[])
`;

const KTP_LEXICAL_QUERY = `
  with candidates as (
    select
      p.id, p.document_id, p.section_id, d.ktp_number, d.title, d.status, d.last_verified,
      s.level as section_level, s.number as section_number, s.name as section_name,
      p.source_file, p.has_image, p.text,
      p.context_text, p.block_type, p.parent_point_title, p.topic_label, p.figure_files,
      translate(
        lower(concat_ws(' ', d.ktp_number, d.title, s.level, s.number, s.name, p.text)),
        'çëàáâãäåèéêìíîïòóôõöùúûüýÿ',
        'ceaaaaaaeeeiiiiooooouuuuyy'
      ) as haystack
    from ktp_paragraphs p
    join ktp_documents d on d.id = p.document_id
    left join ktp_sections s on s.id = p.section_id
    where
      (cardinality($6::text[]) = 0 or d.id = any($6::text[]))
      and (
        cardinality($1::text[]) = 0
        or d.ktp_number = any($1::text[])
        or replace(d.ktp_number, 'N.', '') = any($1::text[])
      )
  )
  select
    id, document_id, section_id, ktp_number, title, status, last_verified, section_level,
    section_number, section_name, source_file, has_image, text,
    context_text, block_type, parent_point_title, topic_label, figure_files,
    (
      case when cardinality($1::text[]) > 0 then 0.45 else 0 end
      + case when cardinality($2::text[]) > 0 and section_number = any($2::text[]) then 0.35 else 0 end
      + case when haystack like any($3::text[]) then 0.24 else 0 end
      + coalesce((select count(*)::float * 0.03 from unnest($4::text[]) term where haystack like term), 0)
    )::float as score
  from candidates
  where
    haystack like any($3::text[])
    or (cardinality($1::text[]) > 0 and (cardinality($4::text[]) = 0 or haystack like all($4::text[])))
    or (cardinality($2::text[]) > 0 and section_number = any($2::text[]))
  order by score desc, ktp_number nulls last, section_number nulls last, id
  limit $5
`;

const KTP_CONTEXT_QUERY = `
  with seeds as (
    select p.id, p.document_id, p.section_id, sec.parent_id
    from ktp_paragraphs p
    left join ktp_sections sec on sec.id = p.section_id
    where p.id = any($1::text[])
  ),
  related_sections as (
    select section_id as id from seeds where section_id is not null
    union
    select parent_id as id from seeds where parent_id is not null
    union
    select child.id
    from ktp_sections child
    join seeds s on child.parent_id = s.parent_id
    where s.parent_id is not null
    union
    select child.id
    from ktp_sections child
    join seeds s on child.parent_id = s.section_id
    where s.section_id is not null
  ),
  ordered as (
    select
      p.id,
      p.document_id,
      p.section_id,
      row_number() over (
        partition by p.document_id
        order by coalesce(sec.sort_order, 999999), p.id
      ) as rn
    from ktp_paragraphs p
    left join ktp_sections sec on sec.id = p.section_id
    where p.document_id in (select document_id from seeds)
  ),
  seed_positions as (
    select o.document_id, o.rn
    from ordered o
    where o.id = any($1::text[])
  ),
  candidate_ids as (
    select distinct o.id,
      case
        when o.section_id in (select id from related_sections where id is not null) then 0.62
        else greatest(0.40, 0.60 - min(abs(o.rn - sp.rn))::float * 0.02)
      end as score
    from ordered o
    join seed_positions sp on sp.document_id = o.document_id
    where o.id <> all($1::text[])
      and (
        o.section_id in (select id from related_sections where id is not null)
        or abs(o.rn - sp.rn) <= $2
      )
    group by o.id, o.section_id
  )
  select
    p.id, p.document_id, p.section_id, d.ktp_number, d.title, d.status, d.last_verified,
    s.level as section_level, s.number as section_number, s.name as section_name,
    p.source_file, p.has_image, p.text,
    p.context_text, p.block_type, p.parent_point_title, p.topic_label, p.figure_files,
    c.score::float as score
  from ktp_paragraphs p
  join candidate_ids c on c.id = p.id
  join ktp_documents d on d.id = p.document_id
  left join ktp_sections s on s.id = p.section_id
  order by c.score desc, coalesce(s.sort_order, 999999), p.id
  limit $3
`;

const KTP_DOCUMENT_SCOPED_QUERY = `
  with candidates as (
    select
      p.id, p.document_id, p.section_id, d.ktp_number, d.title, d.status, d.last_verified,
      s.level as section_level, s.number as section_number, s.name as section_name,
      p.source_file, p.has_image, p.text,
      p.context_text, p.block_type, p.parent_point_title, p.topic_label, p.figure_files,
      translate(
        lower(concat_ws(' ', d.ktp_number, d.title, s.level, s.number, s.name, p.text)),
        'çëàáâãäåèéêìíîïòóôõöùúûüýÿ',
        'ceaaaaaaeeeiiiiooooouuuuyy'
      ) as haystack
    from ktp_paragraphs p
    join ktp_documents d on d.id = p.document_id
    left join ktp_sections s on s.id = p.section_id
    where d.id = any($1::text[])
  )
  select
    id, document_id, section_id, ktp_number, title, status, last_verified, section_level,
    section_number, section_name, source_file, has_image, text,
    context_text, block_type, parent_point_title, topic_label, figure_files,
    (
      case when haystack like any($2::text[]) then 0.30 else 0 end
      + coalesce((select count(*)::float * 0.045 from unnest($3::text[]) term where haystack like term), 0)
    )::float as score
  from candidates
  where haystack like any($2::text[]) or haystack like any($3::text[])
  order by score desc, section_number nulls last, id
  limit $4
`;

const KTP_POINT_PREFIX_CONTEXT_QUERY = `
  with seeds as (
    select p.id, p.document_id, s.number as section_number
    from ktp_paragraphs p
    left join ktp_sections s on s.id = p.section_id
    where p.id = any($1::text[])
      and s.number ~ '^\\d+([.-]\\d+)+$'
  )
  select
    p.id, p.document_id, p.section_id, d.ktp_number, d.title, d.status, d.last_verified,
    s.level as section_level, s.number as section_number, s.name as section_name,
    p.source_file, p.has_image, p.text,
    p.context_text, p.block_type, p.parent_point_title, p.topic_label, p.figure_files,
    0.66::float as score
  from ktp_paragraphs p
  join ktp_documents d on d.id = p.document_id
  left join ktp_sections s on s.id = p.section_id
  where p.id <> all($1::text[])
    and exists (
      select 1
      from seeds seed
      where seed.document_id = p.document_id
        and (s.number like seed.section_number || '.%' or s.number like seed.section_number || '-%')
    )
  order by coalesce(s.sort_order, 999999), p.id
  limit $2
`;

const KTP_SECTION_RANGE_CONTEXT_QUERY = `
  with seeds as (
    select
      p.document_id,
      s.number as section_number,
      split_part(replace(s.number, '-', '.'), '.', 1) as major,
      split_part(replace(s.number, '-', '.'), '.', 2) as minor,
      nullif(split_part(replace(s.number, '-', '.'), '.', 3), '')::int as point
    from ktp_paragraphs p
    left join ktp_sections s on s.id = p.section_id
    where p.id = any($1::text[])
      and s.number ~ '^\\d+[.-]\\d+[.-]\\d+$'
  )
  select
    p.id, p.document_id, p.section_id, d.ktp_number, d.title, d.status, d.last_verified,
    s.level as section_level, s.number as section_number, s.name as section_name,
    p.source_file, p.has_image, p.text,
    p.context_text, p.block_type, p.parent_point_title, p.topic_label, p.figure_files,
    0.72::float as score
  from ktp_paragraphs p
  join ktp_documents d on d.id = p.document_id
  left join ktp_sections s on s.id = p.section_id
  where p.id <> all($1::text[])
    and s.number ~ '^\\d+[.-]\\d+[.-]\\d+$'
    and exists (
      select 1
      from seeds seed
      where seed.document_id = p.document_id
        and split_part(replace(s.number, '-', '.'), '.', 1) = seed.major
        and split_part(replace(s.number, '-', '.'), '.', 2) = seed.minor
        and nullif(split_part(replace(s.number, '-', '.'), '.', 3), '')::int between seed.point and seed.point + $2
    )
  order by coalesce(s.sort_order, 999999), s.number, p.id
  limit $3
`;

const KTP_ROLLUP_AND_TABLE_QUERY = `
  with seeds as (
    select p.section_id
    from ktp_paragraphs p
    where p.id = any($1::text[]) and p.section_id is not null
  )
  select
    p.id, p.document_id, p.section_id, d.ktp_number, d.title, d.status, d.last_verified,
    s.level as section_level, s.number as section_number, s.name as section_name,
    p.source_file, p.has_image, p.text,
    p.context_text, p.block_type, p.parent_point_title, p.topic_label, p.figure_files,
    0.58::float as score
  from ktp_paragraphs p
  join ktp_documents d on d.id = p.document_id
  left join ktp_sections s on s.id = p.section_id
  where p.id <> all($1::text[])
    and p.block_type in ('rollup', 'table', 'figure')
    and p.section_id in (select section_id from seeds)
  order by coalesce(s.sort_order, 999999), p.id
  limit $2
`;

const KTP_GRAPH_RELATED_QUERY = `
  with seed_nodes as (
    select n.id as node_id
    from ktp_graph_nodes n
    join ktp_paragraphs p
      on p.ktp_number = n.extra->>'ktp_number'
      and p.point = n.extra->>'point'
      and p.chunk_index = (n.extra->>'chunk_index')::int
    where p.id = any($1::text[])
  ),
  related_nodes as (
    select e.dst_id as node_id, max(e.score) as score from ktp_graph_edges e
    join seed_nodes sn on sn.node_id = e.src_id
    group by e.dst_id
    union all
    select e.src_id as node_id, max(e.score) as score from ktp_graph_edges e
    join seed_nodes sn on sn.node_id = e.dst_id
    group by e.src_id
  ),
  ranked as (
    select node_id, max(score) as score from related_nodes group by node_id
  )
  select
    p.id, p.document_id, p.section_id, d.ktp_number, d.title, d.status, d.last_verified,
    s.level as section_level, s.number as section_number, s.name as section_name,
    p.source_file, p.has_image, p.text,
    p.context_text, p.block_type, p.parent_point_title, p.topic_label, p.figure_files,
    0.5::float as score
  from ranked r
  join ktp_graph_nodes n on n.id = r.node_id
  join ktp_paragraphs p
    on p.ktp_number = n.extra->>'ktp_number'
    and p.point = n.extra->>'point'
    and p.chunk_index = (n.extra->>'chunk_index')::int
  join ktp_documents d on d.id = p.document_id
  left join ktp_sections s on s.id = p.section_id
  where p.id <> all($1::text[])
  order by r.score desc nulls last
  limit $2
`;

const KTP_SECTION_DESCENDANTS_QUERY = `
  with recursive descendants as (
    select id from ktp_sections where id = $1
    union all
    select s.id
    from ktp_sections s
    join descendants d on s.parent_id = d.id
  )
  select
    p.id, p.document_id, p.section_id, d.ktp_number, d.title, d.status, d.last_verified,
    s.level as section_level, s.number as section_number, s.name as section_name,
    p.source_file, p.has_image, p.text,
    p.context_text, p.block_type, p.parent_point_title, p.topic_label, p.figure_files
  from ktp_paragraphs p
  join ktp_documents d on d.id = p.document_id
  left join ktp_sections s on s.id = p.section_id
  where p.section_id in (select id from descendants)
  order by coalesce(s.sort_order, 999999), p.chunk_index
`;

const NTC_CHUNKS_BY_ID_QUERY = `
  select
    p.id, p.document_id, p.document, d.title, d.status, d.last_verified,
    'paragrafo' as section_level, p.dotted_number as section_number,
    s.name as section_name, p.capitolo, p.capitolo_title, p.ntc_version,
    p.source_file, p.has_image, p.text
  from ntc_paragraphs p
  left join ntc_documents d on d.id = p.document_id
  left join ntc_sections s on s.id = p.section_id
  where p.id = any($1::text[])
`;

const NTC_LEXICAL_QUERY = `
  with candidates as (
    select
      p.id, p.document_id, p.document, d.title, d.status, d.last_verified,
      'paragrafo' as section_level, p.dotted_number as section_number,
      s.name as section_name, p.capitolo, p.capitolo_title, p.ntc_version,
      p.source_file, p.has_image, p.text,
      lower(concat_ws(' ', p.document, d.title, p.dotted_number, s.name, p.capitolo_title, p.text)) as haystack
    from ntc_paragraphs p
    left join ntc_documents d on d.id = p.document_id
    left join ntc_sections s on s.id = p.section_id
    where
      (cardinality($6::text[]) = 0 or p.document_id = any($6::text[]))
      and (cardinality($1::text[]) = 0 or p.dotted_number = any($1::text[]))
  )
  select
    id, document_id, document, title, status, last_verified, section_level, section_number,
    section_name, capitolo, capitolo_title, ntc_version, source_file, has_image, text,
    (
      case when cardinality($1::text[]) > 0 and section_number = any($1::text[]) then 0.55 else 0 end
      + case when haystack like any($2::text[]) then 0.24 else 0 end
      + coalesce((select count(*)::float * 0.03 from unnest($3::text[]) term where haystack like term), 0)
      + case when document = 'Circolare' and lower($4) like '%circolare%' then 0.12 else 0 end
      + case when document = 'NTC' and lower($4) like '%ntc%' then 0.12 else 0 end
    )::float as score
  from candidates
  where
    haystack like any($2::text[])
    or (cardinality($1::text[]) > 0 and section_number = any($1::text[]))
  order by score desc, document, section_number nulls last, id
  limit $5
`;

const NTC_COMMENTARY_QUERY = `
  select
    p.id, p.document_id, p.document, d.title, d.status, d.last_verified,
    'paragrafo' as section_level, p.dotted_number as section_number,
    s.name as section_name, p.capitolo, p.capitolo_title, p.ntc_version,
    p.source_file, p.has_image, p.text
  from ntc_paragraphs p
  left join ntc_documents d on d.id = p.document_id
  left join ntc_sections s on s.id = p.section_id
  where p.dotted_number = any($1::text[])
    and (
      ($2::text = 'NTC' and p.document = 'Circolare')
      or ($2::text = 'Circolare' and p.document = 'NTC')
    )
  order by p.document, p.id
  limit $3
`;

const EUROCODE_CHUNKS_BY_ID_QUERY = `
  select
    p.id, p.source_vector_id, p.document_id, p.en_number, d.title,
    s.level as section_level, s.number as section_number, s.name as section_name,
    p.clause_number, p.parent_clause, p.chunk_type, p.is_procedural,
    p.has_table, p.has_formula, p.has_note, p.text
  from eurocode_paragraphs p
  left join eurocode_documents d on d.id = p.document_id
  left join eurocode_sections s on s.id = p.section_id
  where p.id = any($1::text[])
`;

const EUROCODE_LEXICAL_QUERY = `
  with candidates as (
    select
      p.id, p.source_vector_id, p.document_id, p.en_number, d.title,
      s.level as section_level, s.number as section_number, s.name as section_name,
      p.clause_number, p.parent_clause, p.chunk_type, p.is_procedural,
      p.has_table, p.has_formula, p.has_note, p.text,
      lower(concat_ws(' ', p.en_number, d.title, p.clause_number, p.parent_clause,
        p.chunk_type, p.text)) as haystack
    from eurocode_paragraphs p
    left join eurocode_documents d on d.id = p.document_id
    left join eurocode_sections s on s.id = p.section_id
    where
      (cardinality($6::text[]) = 0 or p.document_id = any($6::text[]))
      and (
        cardinality($1::text[]) = 0
        or replace(lower(coalesce(p.en_number, '')), ' ', '') = any($1::text[])
      )
  )
  select
    id, source_vector_id, document_id, en_number, title, section_level, section_number,
    section_name, clause_number, parent_clause, chunk_type, is_procedural, has_table,
    has_formula, has_note, text,
    (
      case when cardinality($1::text[]) > 0 then 0.25 else 0 end
      + case when cardinality($2::text[]) > 0 and clause_number = any($2::text[]) then 0.55 else 0 end
      + case when cardinality($2::text[]) > 0 and parent_clause = any($2::text[]) then 0.30 else 0 end
      + case when haystack like any($3::text[]) then 0.22 else 0 end
      + coalesce((select count(*)::float * 0.025 from unnest($4::text[]) term where haystack like term), 0)
    )::float as score
  from candidates
  where
    haystack like any($3::text[])
    or (cardinality($2::text[]) > 0 and (clause_number = any($2::text[]) or parent_clause = any($2::text[])))
  order by score desc, en_number nulls last, clause_number nulls last, id
  limit $5
`;

const EUROCODE_EXPAND_CONTEXT_QUERY = `
  select
    p.id, p.source_vector_id, p.document_id, p.en_number, d.title,
    s.level as section_level, s.number as section_number, s.name as section_name,
    p.clause_number, p.parent_clause, p.chunk_type, p.is_procedural,
    p.has_table, p.has_formula, p.has_note, p.text,
    0.62::float as score
  from eurocode_paragraphs p
  left join eurocode_documents d on d.id = p.document_id
  left join eurocode_sections s on s.id = p.section_id
  where p.id <> all($1::text[])
    and (
      (p.document_id, coalesce(p.parent_clause, p.clause_number, '')) in (
        select * from unnest($2::text[], $3::text[])
      )
      or (cardinality($4::text[]) > 0 and p.document_id = any($2::text[]) and p.clause_number = any($4::text[]))
    )
  order by p.en_number nulls last, p.parent_clause nulls last, p.clause_number nulls last, p.id
  limit $5
`;

function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9./-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function buildLexicalPatterns(query: string): { phrases: string[]; terms: string[] } {
  const normalized = normalizeSearchText(query);
  const tokens = unique(
    normalized
      .split(" ")
      .filter((token) => token.length >= 3 && !/^\d+$/.test(token))
      .filter((token) => !["the", "and", "for", "con", "del", "della", "delle", "per", "nga", "dhe", "ose"].includes(token)),
  );
  return {
    phrases: unique([
      tokens.length >= 2 ? `%${tokens.slice(0, 5).join("%")}%` : "",
      ...tokens.map((token) => `%${token}%`),
    ]).slice(0, 28),
    terms: tokens.map((token) => `%${token}%`).slice(0, 24),
  };
}

export function extractKtpNumbers(query: string): string[] {
  const values: string[] = [];
  for (const match of query.matchAll(/\b(?:k\.?\s*t\.?\s*p\.?\s*)?(?:n\.?\s*)?(\d{1,2}[-/]\d{2,4})\b/gi)) {
    values.push(match[1]);
    values.push(`N.${match[1]}`);
  }
  return unique(values);
}

export function extractKtpPoints(query: string): string[] {
  const values: string[] = [];
  for (const match of query.matchAll(/\b(?:pika|point|paragrafi|par\.?)\s*(\d+(?:\.\d+){0,4})\b/gi)) {
    values.push(match[1]);
  }
  return unique(values);
}

export function expandKtpQuery(query: string): string {
  const normalized = normalizeSearchText(query);
  const additions: string[] = [];
  if (/\b(truall|truallit|troje|trojet)\b/.test(normalized) && /\bkategor/.test(normalized)) {
    additions.push(
      "trojet e shesheve ndertimit ndahen tri kategori mikrozonimit sizmik tabela studimeve gjeologo inxhinierike",
    );
  }
  if (/\b(zgjidhj|antisizm|karakteristik|ndertesave)\b/.test(normalized)) {
    additions.push(
      "rregullsi strukturore plan lartesi kompaktesise simetrise mure mbajtes materialeve ndertimore lehte transmetimi drejtperdrejte ngarkesave themele punes hapesinore deformacione plastike",
    );
  }
  if (/\beres?\b|\bera\b/.test(normalized)) {
    additions.push("presioni eres shpejtesia llogaritese zona koeficient aerodinamik lartesia konstruksionit");
  }
  if (/\bdebor|bores\b/.test(normalized)) {
    additions.push("ngarkesa debores q0 qn koeficient k mbulesa cati pjerresi zona");
  }
  if (/\brrufe|goditje atmosferike|rrufeprites\b/.test(normalized)) {
    additions.push("mbrojtja nga goditjet atmosferike kategori rrufeprites zbrites tokezim");
  }
  return additions.length ? `${query} ${additions.join(" ")}` : query;
}

function extractNtcSections(query: string): string[] {
  const values: string[] = [];
  for (const match of query.matchAll(/\b(?:§|par(?:agrafo)?|punto|cap(?:itolo)?|ntc|c\.?)?\s*(\d{1,2}(?:\.\d+){1,4})\b/gi)) {
    values.push(match[1]);
  }
  return unique(values);
}

function extractEurocodeNumbers(query: string): string[] {
  const values: string[] = [];
  for (const match of query.matchAll(/\b(?:BS\s+)?EN\s*(199\d(?:[-\s]\d+){0,3})\b/gi)) {
    values.push(`en${match[1].replace(/\s+/g, "-").toLowerCase()}`);
  }
  return unique(values);
}

function extractEurocodeClauses(query: string): string[] {
  const values: string[] = [];
  for (const match of query.matchAll(/\b(?:clause|section|table|annex|§)?\s*([A-Z]?\d{1,2}(?:[.-]\d{1,3}){1,5}[a-z]?|[A-Z]\.?\d{1,3}(?:[.-]\d{1,3})*)\b/gi)) {
    const value = match[1].replace(/-/g, ".");
    if (!/^199\d/.test(value)) values.push(value);
  }
  for (const match of query.matchAll(/\bTable\s+([A-Z]?\d+(?:[.-]\d+)*[a-z]?)\b/gi)) {
    values.push(`Table ${match[1]}`);
  }
  return unique(values);
}

export async function getKtpChunksByIds(chunkIds: string[]): Promise<Map<string, KtpChunk>> {
  if (chunkIds.length === 0) return new Map();
  const { rows } = await getKbPool().query<KtpChunk>(KTP_CHUNKS_BY_ID_QUERY, [chunkIds]);
  return new Map(rows.map((row) => [row.id, row]));
}

export async function searchKtpLexically(query: string, limit = 8, documentIds: string[] = []): Promise<KtpChunk[]> {
  const expandedQuery = expandKtpQuery(query);
  const ktpNumbers = extractKtpNumbers(expandedQuery);
  const points = extractKtpPoints(expandedQuery);
  const { phrases, terms } = buildLexicalPatterns(expandedQuery);
  if (ktpNumbers.length === 0 && points.length === 0 && phrases.length === 0) return [];
  const { rows } = await getKbPool().query<KtpChunk>(KTP_LEXICAL_QUERY, [
    ktpNumbers,
    points,
    phrases.length ? phrases : ["%"],
    terms.length ? terms : ["%"],
    limit,
    documentIds,
  ]);
  return rows.map((row) => ({ ...row, retrieval_source: "postgres_lexical" }));
}

export async function getKtpContextChunks(chunks: KtpChunk[], limit = 10, neighborWindow = 1): Promise<KtpChunk[]> {
  const ids = unique(chunks.map((chunk) => chunk.id));
  if (ids.length === 0) return [];
  const { rows } = await getKbPool().query<KtpChunk>(KTP_CONTEXT_QUERY, [ids.slice(0, 8), neighborWindow, limit]);
  return rows.map((row) => ({ ...row, retrieval_source: "postgres_context" }));
}

export async function getKtpPointPrefixContextChunks(chunks: KtpChunk[], limit = 10): Promise<KtpChunk[]> {
  const ids = unique(chunks.map((chunk) => chunk.id));
  if (ids.length === 0) return [];
  const { rows } = await getKbPool().query<KtpChunk>(KTP_POINT_PREFIX_CONTEXT_QUERY, [ids.slice(0, 8), limit]);
  return rows.map((row) => ({ ...row, retrieval_source: "postgres_point_context" }));
}

export async function getKtpSectionRangeContextChunks(
  chunks: KtpChunk[],
  forwardWindow = 8,
  limit = 16,
): Promise<KtpChunk[]> {
  const ids = unique(chunks.map((chunk) => chunk.id));
  if (ids.length === 0) return [];
  const { rows } = await getKbPool().query<KtpChunk>(KTP_SECTION_RANGE_CONTEXT_QUERY, [
    ids.slice(0, 8),
    forwardWindow,
    limit,
  ]);
  return rows.map((row) => ({ ...row, retrieval_source: "postgres_section_range" }));
}

export async function getKtpRollupAndTableChunks(chunks: KtpChunk[], limit = 6): Promise<KtpChunk[]> {
  const ids = unique(chunks.map((chunk) => chunk.id));
  if (ids.length === 0) return [];
  const { rows } = await getKbPool().query<KtpChunk>(KTP_ROLLUP_AND_TABLE_QUERY, [ids.slice(0, 8), limit]);
  return rows.map((row) => ({ ...row, retrieval_source: "postgres_rollup_table" }));
}

/** Uses ktp_graph_nodes/ktp_graph_edges (KTP-only snapshot of the shared kg_nodes/kg_edges
 * knowledge graph, RELATED_TOPIC edges only) to pull in paragraphs the graph says are related
 * to the seed chunks, regardless of section/document boundaries. Node<->paragraph mapping is
 * via ktp_number+point+chunk_index (the graph build's node id embeds these in `extra`, not a
 * direct FK to ktp_paragraphs.id). */
export async function getKtpGraphRelatedChunks(chunks: KtpChunk[], limit = 12): Promise<KtpChunk[]> {
  const ids = unique(chunks.map((chunk) => chunk.id));
  if (ids.length === 0) return [];
  const { rows } = await getKbPool().query<KtpChunk>(KTP_GRAPH_RELATED_QUERY, [ids.slice(0, 6), limit]);
  return rows.map((row) => ({ ...row, retrieval_source: "postgres_graph_related" }));
}

export async function getKtpParagraphsForSectionDescendants(sectionId: string): Promise<KtpChunk[]> {
  const { rows } = await getKbPool().query<KtpChunk>(KTP_SECTION_DESCENDANTS_QUERY, [sectionId]);
  return rows.map((row) => ({ ...row, retrieval_source: "postgres_section_descendants" }));
}

export async function searchKtpWithinDocuments(
  query: string,
  documentIds: string[],
  limit = 8,
): Promise<KtpChunk[]> {
  const scopedDocumentIds = unique(documentIds);
  if (scopedDocumentIds.length === 0) return [];
  const { phrases, terms } = buildLexicalPatterns(expandKtpQuery(query));
  if (phrases.length === 0 && terms.length === 0) return [];
  const { rows } = await getKbPool().query<KtpChunk>(KTP_DOCUMENT_SCOPED_QUERY, [
    scopedDocumentIds,
    phrases.length ? phrases : ["%"],
    terms.length ? terms : ["%"],
    limit,
  ]);
  return rows.map((row) => ({ ...row, retrieval_source: "postgres_document_scoped" }));
}

export async function getNtcChunksByIds(chunkIds: string[]): Promise<Map<string, NtcChunk>> {
  if (chunkIds.length === 0) return new Map();
  const { rows } = await getKbPool().query<NtcChunk>(NTC_CHUNKS_BY_ID_QUERY, [chunkIds]);
  return new Map(rows.map((row) => [row.id, row]));
}

export async function searchNtcLexically(query: string, limit = 8, documentIds: string[] = []): Promise<NtcChunk[]> {
  const sections = extractNtcSections(query);
  const { phrases, terms } = buildLexicalPatterns(query);
  if (sections.length === 0 && phrases.length === 0) return [];
  const { rows } = await getKbPool().query<NtcChunk>(NTC_LEXICAL_QUERY, [
    sections,
    phrases.length ? phrases : ["%"],
    terms.length ? terms : ["%"],
    query,
    limit,
    documentIds,
  ]);
  return rows.map((row) => ({ ...row, retrieval_source: "postgres_lexical" }));
}

export async function getNtcCounterpartChunks(chunks: NtcChunk[], limit = 6): Promise<NtcChunk[]> {
  const sectionNumbers = unique(chunks.map((chunk) => chunk.section_number ?? ""));
  const dominant = chunks.some((chunk) => chunk.document === "NTC") ? "NTC" : "Circolare";
  if (sectionNumbers.length === 0) return [];
  const { rows } = await getKbPool().query<NtcChunk>(NTC_COMMENTARY_QUERY, [
    sectionNumbers.slice(0, 8),
    dominant,
    limit,
  ]);
  return rows.map((row) => ({ ...row, score: 0.65, retrieval_source: "postgres_counterpart" }));
}

export async function getEurocodeChunksByIds(chunkIds: string[]): Promise<Map<string, EurocodeChunk>> {
  if (chunkIds.length === 0) return new Map();
  const { rows } = await getKbPool().query<EurocodeChunk>(EUROCODE_CHUNKS_BY_ID_QUERY, [chunkIds]);
  return new Map(rows.map((row) => [row.id, row]));
}

export async function searchEurocodeLexically(query: string, limit = 8, documentIds: string[] = []): Promise<EurocodeChunk[]> {
  const expandedQuery =
    /\bwind\b/i.test(query) && /\b(actions?|determin|consider)\b/i.test(query)
      ? `${query} external internal pressure pressures calculation procedures Table 5.1`
      : query;
  const enNumbers = extractEurocodeNumbers(expandedQuery);
  const clauses = extractEurocodeClauses(expandedQuery);
  const { phrases, terms } = buildLexicalPatterns(expandedQuery);
  if (enNumbers.length === 0 && clauses.length === 0 && phrases.length === 0) return [];
  const { rows } = await getKbPool().query<EurocodeChunk>(EUROCODE_LEXICAL_QUERY, [
    enNumbers,
    clauses,
    phrases.length ? phrases : ["%"],
    terms.length ? terms : ["%"],
    limit,
    documentIds,
  ]);
  return rows.map((row) => ({ ...row, retrieval_source: "postgres_lexical" }));
}

export async function getEurocodeContextChunks(chunks: EurocodeChunk[], limit = 8): Promise<EurocodeChunk[]> {
  const expandable = chunks.filter(
    (chunk) =>
      chunk.is_procedural ||
      chunk.has_formula ||
      chunk.has_table ||
      chunk.has_note ||
      chunk.text.length < 700 ||
      /\b(above|below|following|preceding|where|given in|according to)\b/i.test(chunk.text),
  );
  if (expandable.length === 0) return [];

  const matchedIds = unique(chunks.map((chunk) => chunk.id));
  const pairs = expandable
    .map((chunk) => ({
      document_id: chunk.document_id,
      parent: chunk.parent_clause ?? chunk.clause_number ?? "",
    }))
    .filter((pair) => pair.parent);
  const documentIds = pairs.map((pair) => pair.document_id);
  const parentClauses = pairs.map((pair) => pair.parent);
  const directClauses = unique(expandable.map((chunk) => chunk.clause_number ?? "").filter(Boolean)).slice(0, 12);
  if (pairs.length === 0 && directClauses.length === 0) return [];

  const { rows } = await getKbPool().query<EurocodeChunk>(EUROCODE_EXPAND_CONTEXT_QUERY, [
    matchedIds,
    documentIds,
    parentClauses,
    directClauses,
    limit,
  ]);
  return rows.map((row) => ({ ...row, retrieval_source: "postgres_context" }));
}

export function rerankEurocodeMatches(chunks: EurocodeChunk[], query: string): EurocodeChunk[] {
  const normalizedQuery = normalizeSearchText(query);
  const requestedEns = extractEurocodeNumbers(query).map((value) => value.replace(/^en/, "en "));
  const requestedClauses = extractEurocodeClauses(query);
  const wantsTable = /\btable\b/i.test(query);
  const wantsWindPressure = /\bwind\b/i.test(query) && /\b(pressure|actions?)\b/i.test(query);
  const wantsWindDetermination =
    /\bwind\b/i.test(query) && /\b(actions?|determining|determination|consider(?:ed)?|taking account)\b/i.test(query);

  return [...chunks]
    .map((chunk) => {
      const en = (chunk.en_number ?? "").toLowerCase();
      const clause = chunk.clause_number ?? "";
      const text = normalizeSearchText(chunk.text);
      let score = chunk.score ?? 0;

      if (requestedEns.length > 0) {
        if (requestedEns.some((requested) => en.replace(/\s+/g, "") === requested.replace(/\s+/g, ""))) {
          score += 0.18;
        } else if (en) {
          score -= 0.35;
        }
      }
      if (requestedClauses.includes(clause)) score += 0.18;
      if (wantsTable && chunk.chunk_type === "table") score += 0.08;
      if (wantsWindPressure && text.includes("external") && text.includes("internal") && text.includes("pressure")) {
        score += 0.24;
      }
      if (wantsWindDetermination && en.replace(/\s+/g, "") === "en1991-1-4") {
        if (clause === "Table 5.1") score += 0.55;
        if (text.includes("wind actions") && text.includes("determined taking account")) score += 0.30;
        if (text.includes("calculation procedures for the determination of wind actions")) score += 0.30;
        if (chunk.chunk_type === "annex" || /^annex\b/i.test(clause)) score -= 0.16;
      }
      if (normalizedQuery.includes("where") && chunk.chunk_type === "table") score += 0.08;
      if (chunk.retrieval_source === "postgres_lexical") score += 0.03;

      return { ...chunk, score };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

export function rerankKtpMatches(chunks: KtpChunk[], query: string, ruleOptions: KtpRuleOptions = {}): KtpChunk[] {
  const normalizedQuery = normalizeSearchText(query);
  const requestedKtps = extractKtpNumbers(query).map((value) => value.replace(/^N\./i, ""));
  const requestedPoints = extractKtpPoints(query);
  const queryTokens = unique(
    normalizedQuery
      .split(" ")
      .filter((token) => token.length >= 4 && !/^\d+$/.test(token))
      .filter((token) => !["sipas", "duhet", "jete", "eshte", "cilat", "cili", "cila", "when", "what"].includes(token)),
  );

  return [...chunks]
    .map((chunk) => {
      const ktpNumber = (chunk.ktp_number ?? "")
        .toLowerCase()
        .replace(/^n\.?/, "")
        .trim();
      const sectionNumber = chunk.section_number ?? "";
      const sourceFile = `${chunk.source_file ?? ""} ${chunk.id}`.toLowerCase();
      const text = normalizeSearchText(
        [chunk.ktp_number, chunk.title, chunk.section_level, chunk.section_number, chunk.section_name, chunk.text]
          .filter(Boolean)
          .join(" "),
      );
      let score = chunk.score ?? 0;

      if (requestedKtps.length > 0) {
        if (requestedKtps.includes(ktpNumber)) score += 0.45;
        else if (ktpNumber) score -= 0.35;
      }

      if (requestedPoints.length > 0) {
        if (requestedPoints.includes(sectionNumber)) score += 0.35;
        else if (sectionNumber) score -= 0.08;
      }

      const matchedTerms = queryTokens.filter((token) => text.includes(token)).length;
      score += Math.min(0.22, matchedTerms * 0.035);

      if (chunk.retrieval_source === "postgres_lexical") score += 0.08;
      if (sourceFile.includes("jocilesor") || sourceFile.includes("rag-per-tu-pare-manualisht")) score -= 0.18;
      // Hand-tuned per-topic boosts live in ktp-topic-rules.ts (KTP_RERANK_RULES) so they can be audited / ablated.
      score += applyKtpRerankRules(
        { q: normalizedQuery, ktp: ktpNumber, section: sectionNumber, point: ktpPointFromId(chunk.id), text },
        chunk.id,
        ruleOptions,
      );

      return { ...chunk, score };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}
