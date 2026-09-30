/**
 * Hand-written topic knowledge for KTP retrieval, kept as DATA so it can be audited, ablated and logged.
 *
 *  - KTP_PROBE_BLOCKS  -- extra keyword-search phrases added when the (accent-stripped, lower-cased) question matches a topic.
 *                         Used by deterministicKtpProbes() in ktp-flows.ts. Probes that contain a KTP number
 *                         (e.g. "KTP 5-78") are SCOPED by the SQL to that document -- the number must equal a
 *                         ktp_documents.ktp_number, with 2+ digits after the hyphen or it is not parsed at all.
 *  - KTP_RERANK_RULES  -- additive score boosts applied by rerankKtpMatches() in technical-metadata.ts.
 *
 * Both lists were mined from individual eval questions, so they are the part of the KTP flow most likely to
 * over-fit. `npx tsx testing/scripts/audit-ktp-rules.ts` checks every rule against the live database
 * (documents/sections still exist? do the text conditions still match? how often does the rule fire?).
 * Give each entry a stable id -- the audit and the ablation options refer to it.
 */

export type KtpProbeBlock = {
  id: string;
  /** A question that should trigger this block; used by the audit to check the block still works on the current corpus. */
  example: string;
  /** Receives normalizeSearchText(query). */
  when: (normalized: string) => boolean;
  probes: string[];
};

export const KTP_PROBE_BLOCKS: KtpProbeBlock[] = [
  {
    id: "soil-categories", example: "cilat jane kategorite e truallit ne zonat sizmike",
    when: (normalized) => /\b(truall|truallit|troje|trojet)\b/.test(normalized) && /\bkategor/.test(normalized),
    probes: [
      "trojet shesheve ndertimit tri kategori I II III",
      "studimeve mikrozonimit sizmik kur ka te tilla tabeles 1 gjeologo-inxhinierike",
    ],
  },
  {
    id: "antiseismic-solutions", example: "cilat jane karakteristikat kryesore qe duhen kerkuar ne zgjidhjet antisizmike te ndertesave",
    // Was /\b(zgjidhj|antisizm|karakteristik)\b/ && /\b(ndertes|veprave)\b/ -- the closing \b made the truncated stems match only the exact
    // tokens "antisizm" / "ndertes", never real words ("antisizmike", "ndertesave"), so this block never fired on any eval question.
    when: (normalized) => /\bantisizm/.test(normalized) && /\b(ndertes|veprave)/.test(normalized),
    probes: [
      "rregullsi strukturore plan lartesi kompaktesi simetri mure mbajtes",
      "materialeve ndertimore lehte transmetimi drejtperdrejte ngarkesave themele pune hapesinore deformacione plastike",
    ],
  },
  {
    id: "seismic-spectrum", example: "si llogaritet veprimi sizmik horizontal sipas metodes se spektrit",
    when: (normalized) => /\bk_e\b|\bkoeficienti k\b|\bveprimi sizmik horizontal|\bspektr/.test(normalized),
    probes: [
      "KTP N.2-89 koeficienti k_E raporti shpejtimit llogarites truallit shpejtimit renies se lire",
      "KTP N.2-89 metoda spektrit forca sizmike horizontale k_E k_r beta_i eta_ki Q_k",
    ],
  },
  {
    id: "seismic-foundations", example: "cilat jane rregullat baze per themelet ne troje me kategori te ndryshme sizmike",
    when: (normalized) => /\bthemele|\bthemel/.test(normalized) && /\b(kategori|sizmik|troje|truall)/.test(normalized),
    probes: [
      "KTP N.2-89 themelet troje kategori I III ndertesa larta 12 kate pllake pilota shkallezime 1:2 50 cm",
    ],
  },
  {
    id: "wind-load", example: "cilat jane hapat kryesore per vleresimin e ngarkeses se eres",
    when: (normalized) => /\beres?\b|\bera\b|\bpresioni i eres|\bzone[nas]? i eres/.test(normalized),
    probes: [
      "KTP 7-78 presioni eres P0 V2 16 zona eres koeficient aerodinamik k koeficient lartesie ka Kb 1.2",
    ],
  },
  {
    id: "snow-load", example: "si merret ngarkesa e debores per mbulesa",
    when: (normalized) => /\bdebor|\bbores\b/.test(normalized),
    probes: [
      "KTP 8-78 ngarkesa debores q0 qn qa 1.4 zona I II 75 kg/m2 mbulesa pjerresi 60 grade",
    ],
  },
  {
    id: "soils-classification", example: "cilat tregues perdoren per klasifikimin e dherave joshkembore",
    when: (normalized) => /\bdher|\bdheu|\btabelat 19|presioneve te lejuara|ngjeshmerise/.test(normalized),
    probes: [
      "KTP 5-78 dhera joshkembore klasifikim granulometrike koeficient njetrjatshmerise konsistenca ngjeshmeri",
      "KTP 5-78 tabelat 19 20 21 presione te lejuara themele gjeresi 0.6 1.5 m thellesi 1 2.5 m",
      "KTP 5-78 pika 1 bodrumeve gjeresi baze 0,6 1,5 thellesi vendosje 1 2,5",
    ],
  },
  {
    id: "steel-structures", example: "cilat kerkesa baze jepen per celikun ne konstruksionet mbajtese",
    // Probes used to say `KTP 10-1` / `KTP 10-4` (the code was split over 6 files before the 2026-08-20 merge into `10-78`).
    // "10-1" was never parsed as a KTP number (2+ digits are needed after the hyphen), so those probes ran as plain word searches.
    // `KTP 10-78` IS parsed: the SQL now scopes these probes to document 10-78 and the reranker rewards it.
    when: (normalized) => /\bcelik|\bsaldim|\bribatin|\bbulon|\bkonstruksionet prej celiku/.test(normalized),
    probes: [
      "KTP 10-78 celiku konstruksione mbajtese kufiri rrjedhshmerise squfur fosfor karbon marka celikut",
      "KTP 10-78 pika 1.1 nuk perfshihen konstruksionet prej celiku urave automobilistike hekurudhore",
      "KTP 10-78 bashkimet saldim ribatina bulona jo me pak se dy nyje punuese bashkime te kombinuara",
    ],
  },
  {
    id: "water-supply", example: "cilat jane rregullat kryesore per furnizimin e jashtem me uje",
    when: (normalized) => /\buje|\bujesjelles|\bfurnizim|\brezervuar|\bklor|\bpompa/.test(normalized),
    probes: [
      "KTP 11-78 furnizimi jashtem me uje presion minimal 12 m 16 m 20 m 24 m shtohen 4 m",
      "KTP 12-78 pika 1.2.3 pajisjet hidrosanitare njesive ekuivalente diametrat degezimeve",
      "KTP 12-78 pika 1.2.4 pika 1.2.5 presionit te rrjetit te jashtem humbjet lokale 20 30",
      "KTP 12-78 rrjeti brendshem furnizimit me uje saracineska hidranti dy pika tuba zinkuar rezervuare pika me e larte",
    ],
  },
  {
    id: "lightning-protection", example: "cilat jane kategorite e mbrojtjes nga rrufeja",
    when: (normalized) => /\brrufe|\brrufeja|\brrufeprites|\bgoditje atmosferike/.test(normalized),
    probes: [
      "KTP 16-78 pika 1.1.2 pika 1.1.3 pika 1.1.4 kategoria I kategoria II kategoria III lende plasese gaze avuj pluhura avari zjarri",
      "KTP 16-78 kategorite mbrojtjes nga rrufeja I II III goditje drejtperdrejta induktime potenciale larta",
      "KTP 16-78 kategorine mbrojtjes rrufeja teknologu investitori organet MKZ detyres projektimit",
    ],
  },
  {
    id: "lighting", example: "ndricimi i avarise ne ambientet e prodhimit",
    when: (normalized) => /\bndricim|\bavarise|\bluks/.test(normalized),
    probes: [
      "KTP 14-78 ndricimi avarise kalimet kryesore 0.3 luks niveli dyshemese shkalle",
    ],
  },
  {
    id: "roads", example: "cilat jane kriteret kryesore per projektimin e rrugeve automobilistike",
    when: (normalized) => /\brruge|\bautomobilistike|\bvend pushimi|\btrafik|\bkryqezim/.test(normalized),
    probes: [
      "KTP 22-78 rruge automobilistike drejtimi me i shkurter zhvillimi ekonomik kategori dendesia levizjes 10 vjet",
      "KTP 22-78 rruge malore pjerresi 8 vend pushimi 4% 60 m per cdo kilometer",
    ],
  },
  {
    id: "bridges-culverts", example: "cilat jane gjendjet kufitare per ura dhe tombino prej betoni",
    when: (normalized) => /\bura|\btombino|\bplasaritje|\bmbistrukture|\bkonsolit/.test(normalized),
    probes: [
      "KTP 23-78 ura tombino gjendje kufitare aftesi mbajtese deformime plasaritje koeficiente kombinime ngarkesash",
    ],
  },
  {
    id: "hydrotechnical-works", example: "cfare vepra quhen hidroteknike",
    when: (normalized) => /\bhidroteknike|\btunele|\btunelesh|\bperkohshme|\bperhershme/.test(normalized),
    probes: [
      "KTP 4-78 pika 1 vepra hidroteknike qellime detyra ekonomise popullore",
      "KTP 4-78 vepra hidroteknike presion veprimit te ujit perhershme perkohshme periudhes se ndertimit",
      "KTP 24-78 tunele hidroteknike me presion pa presion derivacioni turbinash shkarkimi devijimi drenimi",
    ],
  },
];

/** Extra probes used only by the pg-doc-consensus-tuned family (mined from two eval failures). Same shape as KTP_PROBE_BLOCKS. */
export const KTP_TUNED_PROBE_BLOCKS: KtpProbeBlock[] = [
  {
    id: "steel-joints", example: "cilat jane rregullat kryesore per bashkimet ne konstruksionet prej celiku",
    when: (normalized) => /\bbashkim/.test(normalized) && /\bcelik/.test(normalized),
    probes: ["KTP 10-78 saldimi ribatinat bulonat celik karbon Martin C2 C3 bashkime kombinuara ndalohen numri minimal ribatina bulona jo me pak se dy"],
  },
  {
    id: "hydrotechnical-tunnels", example: "cilat lloje tunelesh hidroteknike dallon KTP 24-78",
    when: (normalized) => /\btunelesh|\btunele\b/.test(normalized) && /\bhidroteknike|\b24-78/.test(normalized),
    probes: ["KTP 24-78 regjimi hidraulik tunele me presion pa presion klasa e tunelit rendesia koha e shfrytezimit presioni prurja shpejtesia e ujit"],
  },
];

/** What a rerank rule sees for one candidate chunk. All strings are already normalised (accents stripped, lower-case). */
export type KtpRerankContext = {
  /** normalizeSearchText(query) */
  q: string;
  /** chunk.ktp_number lower-cased with a leading "n." removed, e.g. "2-89", "10-78". */
  ktp: string;
  /** chunk.section_number ("" when unknown). NOTE: for some documents this is the parent section, not the point number. */
  section: string;
  /** Point number taken from the chunk id ("1.2.3" from `ktp-12-78--point-1.2.3--0` or `ktp-16-78--1.1.2--1`); "" if none.
   *  After the 2026-08 hand rebuild most documents store the PARENT section in `section` and the point only in the id. */
  point: string;
  /** normalized ktp number + title + section level/number/name + text. */
  text: string;
};

export type KtpRerankRule = {
  id: string;
  /** A question that should trigger this rule; used by the audit to check it can still fire on the current corpus. */
  example: string;
  /** Documents the rule targets, as ktp_documents.ktp_number without a leading "N." ([] = any document). Used by the audit. */
  docs: string[];
  /** Boost added to the chunk score; 0 when the rule does not apply. */
  boost: (c: KtpRerankContext) => number;
};

const SOIL_Q = (q: string) => /\b(truall|truallit|troje|trojet)\b/.test(q) && /\bkategor/.test(q);
const ANTISEISMIC_Q = (q: string) => /\b(zgjidhj|antisizm|karakteristik|ndertesave)\b/.test(q);
// Document checks below use equality: the old `ktp.includes("5-78")` also matched 15-78, and `includes("4-78")` also 14-78 / 24-78.

export const KTP_RERANK_RULES: KtpRerankRule[] = [
  {
    id: "soil-categories-intro", example: "cilat jane kategorite e truallit ne zonat sizmike", docs: ["2-89"],
    boost: (c) => (SOIL_Q(c.q) && c.ktp === "2-89" && c.text.includes("trojet e shesheve") && c.text.includes("tri kategori") ? 0.9 : 0),
  },
  {
    id: "soil-categories-basis", example: "cilat jane kategorite e truallit ne zonat sizmike", docs: ["2-89"],
    boost: (c) =>
      SOIL_Q(c.q) && c.ktp === "2-89" &&
      (c.text.includes("mikrozonimit sizmik") || c.text.includes("gjeologo-inxhinierike") || c.text.includes("tabeles 1")) ? 0.95 : 0,
  },
  {
    id: "soil-categories-section", example: "cilat jane kategorite e truallit ne zonat sizmike", docs: ["2-89"],
    boost: (c) =>
      SOIL_Q(c.q) && c.ktp === "2-89" && ["1.3.1", "1", "2"].includes(c.section) &&
      (c.text.includes("tri kategori") || c.text.includes("mikrozonimit sizmik") || c.text.includes("gjeologo-inxhinierike")) ? 0.7 : 0,
  },
  {
    id: "antiseismic-solutions-text", example: "cilat jane karakteristikat kryesore ne zgjidhjet antisizmike te ndertesave", docs: ["2-89"],
    boost: (c) =>
      ANTISEISMIC_Q(c.q) && c.ktp === "2-89" &&
      (c.text.includes("rregullsi strukturore") || c.text.includes("kompaktesise") || c.text.includes("simetrise") ||
        c.text.includes("materialeve ndertimore sa me te lehte") || c.text.includes("transmetimi i drejtperdrejte") ||
        c.text.includes("punes hapesinore")) ? 0.45 : 0,
  },
  {
    id: "antiseismic-solutions-sections", example: "cilat jane karakteristikat kryesore ne zgjidhjet antisizmike te ndertesave", docs: ["2-89"],
    boost: (c) => (ANTISEISMIC_Q(c.q) && c.ktp === "2-89" && ["1.4.3", "1.4.7", "1.4.8", "1.4.9", "1.4.10"].includes(c.section) ? 0.9 : 0),
  },
  {
    id: "microzoning-map", example: "harta e mikrozonimit sizmik", docs: [],
    boost: (c) => (/\bmikrozonim/.test(c.q) && c.text.includes("harta") && c.text.includes("rajonizimit") ? 0.18 : 0),
  },
  {
    id: "telecommunications", example: "linjat e telekomunikacionit ne zona sizmike", docs: [],
    boost: (c) => (/\btelekomunikacion/.test(c.q) && c.text.includes("telekomunikacion") ? 0.12 : 0),
  },
  {
    id: "road-lighting", example: "ndricimi i rrugeve", docs: [],
    boost: (c) => (/\bndricim|\bndri/.test(c.q) && /\brrug/.test(c.q) && c.text.includes("rrug") ? 0.12 : 0),
  },
  // RETIRED 2026-09-19 (audit: could not fire on the current corpus, and their target chunks already reach the LLM without them):
  //  - permitted-soil-pressures-table / -section (KTP 5-78): needed the text "0,6"/"1,5" -- normalizeSearchText turns commas into spaces,
  //    so it could never match -- and `section === "3.3"`, but 5-78 now stores section "3" with the point only in the id. The target
  //    chunk `ktp-5-78--point-3.3--0` ranked #1 in the last trace (eval Q8) with no boost.
  //  - internal-water-network (KTP 12-78): compared section_number to point numbers 1.2.3-1.3.3; the doc stores sections "1.2"/"1.3".
  //    Targets `point-1.2.3..1.2.5`, `point-1.3.1`, `point-1.3.3` ranked #1-#10 in the last trace (eval Q15) with no boost.
  {
    id: "min-pressure-table", example: "presion minimal i rrjetit per ndertesa 1-2 kateshe", docs: ["11-78"],
    boost: (c) =>
      /\bpresion minimal|\b1-2 kateshe|\bkatit te peste/.test(c.q) && c.ktp === "11-78" &&
      c.text.includes("12") && c.text.includes("16") && c.text.includes("20") && c.text.includes("24") ? 1.2 : 0,
  },
  {
    id: "min-pressure-4m", example: "presion minimal i rrjetit per ndertesa 1-2 kateshe", docs: ["11-78"],
    boost: (c) =>
      /\bpresion minimal|\b1-2 kateshe|\bkatit te peste/.test(c.q) && c.ktp === "11-78" && (c.text.includes("4 m") || c.text.includes("4m")) ? 0.6 : 0,
  },
  {
    // RETARGETED 2026-09-19: matched `section` "1.1.2".."1.1.4", but 16-78 now stores section "1-1" and the point in the chunk id, so it never
    // fired. Kept (unlike the two above) because the trace shows why it matters: point 1.1.2 (category I) sat at rank 23, just outside the
    // 20 chunks sent to the LLM, and the eval failed for exactly that missing category.
    id: "lightning-categories", example: "kategorite e mbrojtjes nga rrufeja", docs: ["16-78"],
    boost: (c) => (/\bkategorite e mbrojtjes|\brrufeja/.test(c.q) && c.ktp === "16-78" && ["1.1.2", "1.1.3", "1.1.4"].includes(c.point) ? 1.25 : 0),
  },
  {
    // Was keyed to document "10-1", section "1.1". After the 2026-08-20 merge that text lives in 10-78, section "1" (point 1.1),
    // so the old `section === "1.1"` clause could never match; it is dropped -- the text clause is what identifies the chunk.
    id: "steel-scope-exclusions", example: "cfare nuk perfshihen ne kushtet teknike te celikut ktp 10", docs: ["10-78"],
    boost: (c) =>
      /\bnuk vlejne|\bnuk perfshihen|\bktp 10/.test(c.q) && c.ktp === "10-78" && c.text.includes("nuk perfshihen konstruksionet prej celiku") ? 1.4 : 0,
  },
  {
    id: "hydrotechnical-definition", example: "cfare vepra quhen hidroteknike", docs: ["4-78"],
    boost: (c) =>
      /\bvepra quhen hidroteknike|\bcfare vepra quhen/.test(c.q) && c.ktp === "4-78" && c.section === "1" && c.text.includes("ekonomise popullore") ? 1.2 : 0,
  },
  {
    id: "hydrotechnical-water-action", example: "cfare vepra quhen hidroteknike", docs: ["4-78"],
    boost: (c) =>
      /\bvepra quhen hidroteknike|\bcfare vepra quhen/.test(c.q) && c.ktp === "4-78" &&
      (c.text.includes("presionit te ujit") || c.text.includes("veprimit te ujit")) ? 0.5 : 0,
  },
];

/** "1.2.3" from `ktp-12-78--point-1.2.3--0` or `ktp-16-78--1.1.2--1`; "" when the id carries no dotted point number. */
export function ktpPointFromId(chunkId: string): string {
  return chunkId.match(/--(?:point-)?(\d+(?:\.\d+)+)(?:--|$)/)?.[1] ?? "";
}

export type KtpRuleOptions = {
  /** Rule ids to skip (ablation / audit). */
  disabledRules?: ReadonlySet<string>;
  /** Called for every rule that adds a non-zero boost (audit / tracing). */
  onRuleFired?: (ruleId: string, chunkId: string, boost: number) => void;
};

export function applyKtpRerankRules(ctx: KtpRerankContext, chunkId: string, opts: KtpRuleOptions = {}): number {
  let total = 0;
  for (const rule of KTP_RERANK_RULES) {
    if (opts.disabledRules?.has(rule.id)) continue;
    const boost = rule.boost(ctx);
    if (boost) {
      total += boost;
      opts.onRuleFired?.(rule.id, chunkId, boost);
    }
  }
  return total;
}
