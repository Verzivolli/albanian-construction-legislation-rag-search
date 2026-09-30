/**
 * Query normaliser for the KTP keyword search (used by the pg-doc-consensus-tuned-normalize flow).
 *
 * The keyword search is exact-word SQL over old-fashioned Albanian technical text, so it fails on input that is not clean,
 * standard Albanian (measured 2026-09-19, testing/evals/ktp-query-gap-2026-09-19.md: English 0/5 right document, one typo case
 * wrong document, follow-ups wrong document). This module repairs the query BEFORE probing:
 *
 *   1. deterministic (no LLM): fold the text, snap typos to real corpus words (edit distance against ktp-vocabulary.json),
 *      detect the language, detect words the corpus does not contain, detect a likely follow-up;
 *   2. ONE gated LLM call, only when step 1 says it is needed (not Albanian / unknown words left / follow-up): translate,
 *      rewrite a follow-up into a standalone question, fix dialect/mistyped words, prefer the corpus' own terms from
 *      ktp-glossary.json (only the entries that match the question are sent) -- and KEEP all technical Albanian wording;
 *   3. validate the LLM output (numbers/KTP numbers must survive) and fail open to the deterministic result on any problem.
 *
 * A clean standalone Albanian question costs nothing extra: no LLM call, same behaviour as plain tuned.
 *
 * Optional Jev gate (options.gate = jevQueryGate, production since 2026-09-26): one typesafe/jev-1.13 call decides language
 * (choice) and follow-up (noul, only with history) in place of the step-1 heuristics; the rewrite LLM can be switched (options.model).
 */
import vocabularyJson from "./ktp-vocabulary.json";
import glossaryJson from "./ktp-glossary.json";
import { foldText } from "./ktp-fold";
import { chatCompletion, type ChatMessage } from "./openrouter-chat";
import type { ChatFn, QAPair } from "./generate-answer";
import { jevDecide } from "./jev";

// ------------------------------------------------------------------ resources
const VOCAB = new Map<string, number>(Object.entries((vocabularyJson as { tokens: Record<string, number> }).tokens));
const VOCAB_LIST = [...VOCAB.entries()].filter(([, df]) => df >= 3);

type GlossaryEntry = { sq: string; en: string[]; source?: string };
// `entries` = terms from the codes' own headings/table captions; `words` = single corpus words with English equivalents (build-ktp-glossary.ts --words)
const GLOSSARY = [
  ...((glossaryJson as { entries?: GlossaryEntry[] }).entries ?? []),
  ...((glossaryJson as { words?: GlossaryEntry[] }).words ?? []),
].filter((e) => e.sq && e.en?.length);

const SQ_STOP = new Set(
  "dhe e te me per nga ne si cilat cilet cili cila jane eshte sipas ose qe ka nje se pas mund duhet kur sa po por i u ato kjo ky keto ai ajo ata kete ku pse cfare cilen cilin cilave secila secili".split(" "),
);
const EN_STOP = new Set(
  "the what are is of for how which when and does be with by from that this can should must where who why about between there their".split(" "),
);
const DEPENDENT_START = /^(po|dhe|edhe|por|ndersa|kurse|ai|ajo|ata|ato|kjo|ky|keto|kete|and|what about|how about|then|also)\b/;
const DEPENDENT_PRONOUN = /\b(tyre|saj|tij|ato|ata)\b| (ne|per|te) to$/;

// ------------------------------------------------------------------ deterministic part
/** Edit distance where insert / delete / adjacent swap cost 1 and a SUBSTITUTION costs 2 (= delete + insert). That makes a single-letter
 * substitution count as a "big" edit, so short words are never snapped onto a different real word ("lodhja" fatigue -> "lidhja" joint).
 * Returns max+1 when the distance is above `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 2;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Nearest real corpus word for a word the corpus does not contain; null when the word is known, short, numeric or the match is ambiguous. */
export function snapToken(tok: string, vocab: Map<string, number> = VOCAB, list: [string, number][] = VOCAB_LIST): string | null {
  if (tok.length < 5 || /\d/.test(tok) || vocab.has(tok)) return null;
  const maxD = tok.length >= 9 ? 2 : 1; // long words may take one substitution (cost 2); short words only a missing/extra/swapped letter
  const hits: { w: string; d: number; df: number }[] = [];
  for (const [w, df] of list) {
    if (Math.abs(w.length - tok.length) > maxD) continue;
    const d = editDistance(tok, w, maxD);
    if (d <= maxD) hits.push({ w, d, df });
  }
  if (!hits.length) return null;
  hits.sort((x, y) => x.d - y.d || y.df - x.df);
  const [top, second] = hits;
  if (second && second.d === top.d && second.df * 3 > top.df) return null; // two equally plausible words -> do not guess
  return top.w;
}

export type Language = "sq" | "en" | "other";

export function detectLanguage(tokens: string[], vocab: Map<string, number> = VOCAB): Language {
  const en = tokens.filter((t) => EN_STOP.has(t)).length;
  const sq = tokens.filter((t) => SQ_STOP.has(t)).length;
  const content = tokens.filter((t) => t.length >= 4 && !/^\d+$/.test(t) && !EN_STOP.has(t) && !SQ_STOP.has(t));
  const known = content.filter((t) => vocab.has(t)).length;
  const oovRatio = content.length ? 1 - known / content.length : 0;
  if (en >= 2 && en > sq) return "en";
  if (en >= 1 && sq === 0 && oovRatio > 0.4) return "en";
  if (sq >= 1 || oovRatio <= 0.4) return "sq";
  return oovRatio > 0.6 ? "other" : "sq";
}

export function looksDependent(folded: string, tokens: string[]): boolean {
  return tokens.length <= 7 || DEPENDENT_START.test(folded) || DEPENDENT_PRONOUN.test(folded);
}

/** Replace snapped words inside the ORIGINAL text, leaving everything else (numbers, "KTP 8-78", punctuation, capitals elsewhere) as typed. */
export function applySnaps(original: string, snaps: { from: string; to: string }[]): string {
  if (!snaps.length) return original;
  const map = new Map(snaps.map((x) => [x.from, x.to]));
  return original.replace(/[\p{L}\p{N}]+/gu, (w) => map.get(foldText(w)) ?? w);
}

export type QueryAnalysis = {
  folded: string;
  language: Language;
  /** typo fixes applied deterministically ({from,to} in folded form) */
  snaps: { from: string; to: string }[];
  snappedQuery: string;
  /** the original text with only the snapped words replaced (safe to use as a query: keeps "KTP 8-78" etc.) */
  repairedQuery: string;
  /** words (4+ letters) still not in the corpus vocabulary after snapping */
  unknownWords: string[];
  dependent: boolean;
  needsLlm: boolean;
  reasons: string[];
};

export function analyzeQuery(query: string, history: QAPair[] = []): QueryAnalysis {
  const folded = foldText(query);
  const tokens = folded.split(" ").filter(Boolean);
  const language = detectLanguage(tokens);
  const snaps: { from: string; to: string }[] = [];
  const snappedTokens = tokens.map((t) => {
    if (language !== "sq" || SQ_STOP.has(t)) return t; // never "fix" English words into Albanian ones
    const s = snapToken(t);
    if (s) snaps.push({ from: t, to: s });
    return s ?? t;
  });
  const unknownWords = snappedTokens.filter((t) => t.length >= 4 && !/^\d+$/.test(t) && !SQ_STOP.has(t) && !EN_STOP.has(t) && !VOCAB.has(t));
  const dependent = history.length > 0 && looksDependent(folded, tokens);
  const reasons: string[] = [];
  if (language !== "sq") reasons.push(`language=${language}`);
  if (unknownWords.length) reasons.push(`words not in corpus: ${unknownWords.slice(0, 4).join(", ")}`);
  if (dependent) reasons.push("possible follow-up (history present, short/dependent wording)");
  return { folded, language, snaps, snappedQuery: snappedTokens.join(" "), repairedQuery: applySnaps(query, snaps), unknownWords, dependent, needsLlm: reasons.length > 0, reasons };
}

// ------------------------------------------------------------------ Jev gate (optional)
export type QueryGate = { language: Language; languageP: number; followup: number; ms: number };
export type GateFn = (query: string, history: QAPair[]) => Promise<QueryGate | null>;

/** Below this Jev probability the heuristic language wins (short questions like "and for category III?" came back en 0.51 / sq 0.48). */
const GATE_LANGUAGE_MIN_P = 0.6;

/** One Jev call: language (choice) + follow-up (noul, only when there is history). null on error / timeout -> heuristics decide. */
export async function jevQueryGate(query: string, history: QAPair[], timeoutMs = 5000): Promise<QueryGate | null> {
  const started = Date.now();
  const state: Record<string, string> = { question: query };
  const questions: Record<string, unknown> = {
    language: {
      type: "choice",
      instructions: "Which language is state.question written in? Albanian is often typed without diacritics (e, c instead of ë, ç).",
      criteria: { sq: "Albanian", en: "English", other: "any other language" },
    },
  };
  if (history.length) {
    state.history = history.slice(-3).map((h) => `Q: ${h.question.slice(0, 200)}\nA: ${h.answer.replace(/\s+/g, " ").slice(0, 200)}`).join("\n");
    questions.followup = {
      type: "noul",
      instructions: "Does state.question depend on state.history to be understood -- a follow-up that refers back to it (pronouns, ellipsis, \"and for X?\") and would be unclear on its own?",
    };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const a = await Promise.race([
      jevDecide(state, questions),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("jev gate timeout")), timeoutMs); }),
    ]);
    const choice = a.language?.choice;
    const language: Language = choice === "en" || choice === "other" ? choice : "sq";
    return { language, languageP: a.language?.probabilities?.[language] ?? 0, followup: a.followup?.noul ?? 0, ms: Date.now() - started };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Re-decides language / follow-up / needsLlm from the Jev gate. Pure. Unknown-word (typo) detection stays deterministic. */
export function applyGate(query: string, a: QueryAnalysis, g: QueryGate, hasHistory: boolean): QueryAnalysis {
  const language = g.languageP >= GATE_LANGUAGE_MIN_P ? g.language : a.language;
  const dependent = hasHistory && g.followup >= 0.5;
  // snaps were made assuming Albanian; never keep English words "fixed" into Albanian ones
  const snapped = language === "sq" ? a : { ...a, snaps: [], snappedQuery: a.folded, repairedQuery: query };
  const reasons: string[] = [];
  if (language !== "sq") reasons.push(`language=${language} (jev p=${g.languageP.toFixed(2)})`);
  if (a.unknownWords.length) reasons.push(`words not in corpus: ${a.unknownWords.slice(0, 4).join(", ")}`);
  if (dependent) reasons.push(`follow-up (jev p=${g.followup.toFixed(2)})`);
  return { ...snapped, language, dependent, needsLlm: reasons.length > 0, reasons };
}

// ------------------------------------------------------------------ glossary lookup (deterministic)
const stemSq = (t: string) => (t.length >= 6 ? t.slice(0, 5) : t);
const stemEn = (t: string) => t.replace(/ies$/, "y").replace(/(ing|ed|es|s)$/, "");
const GLOSSARY_INDEX = GLOSSARY.map((e) => ({
  entry: e,
  sq: new Set(foldText(e.sq).split(" ").filter((t) => t.length >= 4).map(stemSq)),
  en: e.en.map((p) => new Set(foldText(p).split(" ").filter((t) => t.length >= 3 && !EN_STOP.has(t)).map(stemEn))).filter((s) => s.size > 0),
}));

/** Glossary entries that match the question (English words -> English equivalents, Albanian words -> the corpus' own terms). */
export function lookupGlossary(query: string, limit = 12): GlossaryEntry[] {
  const tokens = foldText(query).split(" ").filter((t) => t.length >= 3);
  const qEn = new Set(tokens.filter((t) => !SQ_STOP.has(t)).map(stemEn));
  const qSq = new Set(tokens.filter((t) => t.length >= 4 && !SQ_STOP.has(t)).map(stemSq));
  const scored: { entry: GlossaryEntry; score: number }[] = [];
  for (const g of GLOSSARY_INDEX) {
    let score = 0;
    for (const phrase of g.en) {
      const overlap = [...phrase].filter((s) => qEn.has(s)).length;
      if (overlap && overlap / phrase.size >= 0.5) score = Math.max(score, (overlap / phrase.size) * (1 + 0.15 * overlap));
    }
    const sqOverlap = [...g.sq].filter((s) => qSq.has(s)).length;
    if (sqOverlap && g.sq.size && sqOverlap / g.sq.size >= 0.5) score = Math.max(score, (sqOverlap / g.sq.size) * (1 + 0.15 * sqOverlap));
    if (score > 0) scored.push({ entry: g.entry, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.entry.sq.length - b.entry.sq.length).slice(0, limit).map((s) => s.entry);
}

// ------------------------------------------------------------------ LLM part
export const NORMALIZER_SYSTEM_PROMPT = `You normalise search queries for a retrieval system over the Albanian national technical design codes (KTP, 1978/1989). You do NOT answer the question. Return exactly one JSON object and nothing else.

Do these tasks in this order:
1. Language: detect the language of the user's question ("sq" Albanian, "en" English, "other").
2. If the question is not Albanian, translate it into Albanian.
3. If a chat history is given and the question depends on it (for example "and for category III?", "po per kategorine e trete?", "what about snow?", "dhe si klasifikohen ato?"), rewrite it as ONE complete standalone question. Replace every pronoun or ellipsis ("ato", "ne to", "e tyre", "i tij", "po per X") with the explicit subject words taken from the history, so the new question makes sense with NO history. If the question does not depend on the history, ignore the history.
4. Fix typos, mistyped words and dialect words into standard Albanian.
5. Use the CORPUS TERMS list (when given) whenever a term matches the user's meaning: write the Albanian term exactly as listed -- these are the exact words the codes use.

Rules:
- KEEP ALL TECHNICAL ALBANIAN WORDING: every technical Albanian word or phrase that appears in the user's question or in the CORPUS TERMS must appear in your output exactly as written. Do not paraphrase, modernise, shorten, generalise or replace it with a synonym.
- Keep every number, unit, symbol, formula and KTP number unchanged (for example "KTP 8-78", "N.2-89", "1.3.1", "12 kate").
- Do not add facts, do not answer, and do not add topics the user did not ask about. Keep the same question type (what / how / when / list).
- Every subject word in your output must come from the question or, for a follow-up, from the history question it refers to. Never add a new object, topic or noun (for example do not add "mbrojtja e objekteve" when nobody asked about protection).
- KTP numbers in a follow-up: keep the history's KTP number ONLY when the follow-up asks about the same subject (history "si parashikohet ndricimi i avarise sipas KTP 14-78" / "and in stairwells?" -> keep "KTP 14-78"). When the follow-up switches subject (history about masonry walls in KTP 9-78 / "what about steel connections?"), DROP the history's KTP number -- each KTP code covers a different subject.
- Translate technical terms into the term the Albanian codes use, not word by word (e.g. "bearing capacity" = "aftesia mbajtese", not "kapaciteti mbajtes"; "states" in the sense of conditions = "gjendjet", never "shtetet").
- The Albanian may be written without diacritics.
- If nothing needs to change, return the question unchanged with "changed": false.

Examples (different topics, for format only):
- History Q: "si merret ngarkesa e eres sipas KTP 7-78" / question: "po per debore?" -> {"language":"sq","is_followup":true,"changed":true,"standalone_query":"si merret ngarkesa e debores","corrections":[],"confidence":0.9,"notes":"topic switch, kept ngarkesa"}
- History Q: "cilat jane llojet e tuneleve hidroteknike" / question: "dhe si klasifikohen ato?" -> {"language":"sq","is_followup":true,"changed":true,"standalone_query":"si klasifikohen tunelet hidroteknike","corrections":[],"confidence":0.9,"notes":"resolved ato"}
- No history / question: "what are the requirements for road lighting" -> {"language":"en","is_followup":false,"changed":true,"standalone_query":"cilat jane kerkesat per ndricimin e rrugeve","corrections":[{"from":"road lighting","to":"ndricimin e rrugeve"}],"confidence":0.9,"notes":"translated"}

Output JSON schema:
{"language":"sq|en|other","is_followup":true|false,"changed":true|false,"standalone_query":"<Albanian question>","corrections":[{"from":"<word or phrase>","to":"<replacement>"}],"confidence":0.0,"notes":"<max 20 words>"}`;

export type NormalizerLlmOutput = {
  language: Language;
  is_followup: boolean;
  changed: boolean;
  standalone_query: string;
  corrections: { from: string; to: string }[];
  confidence: number;
  notes: string;
};

function buildUserMessage(query: string, history: QAPair[], glossary: GlossaryEntry[]): string {
  const parts: string[] = [];
  if (glossary.length) parts.push(`CORPUS TERMS (English -> Albanian wording used by the codes):\n${glossary.map((g) => `- ${g.en.slice(0, 3).join("; ")} => ${g.sq}`).join("\n")}`);
  if (history.length) {
    parts.push(
      `CHAT HISTORY (oldest first):\n${history
        .slice(-3)
        .map((h) => `Q: ${h.question.slice(0, 200)}\nA: ${h.answer.replace(/\s+/g, " ").slice(0, 300)}`)
        .join("\n")}`,
    );
  }
  parts.push(`QUESTION: ${query}`);
  return parts.join("\n\n");
}

/** Returns the parsed model output or null (timeout, bad JSON, error). Never throws. */
export async function callNormalizerLlm(query: string, history: QAPair[], glossary: GlossaryEntry[], timeoutMs: number, chat: ChatFn = chatCompletion, model?: string): Promise<{ output: NormalizerLlmOutput | null; ms: number; error?: string }> {
  const messages: ChatMessage[] = [
    { role: "system", content: NORMALIZER_SYSTEM_PROMPT },
    { role: "user", content: buildUserMessage(query, history, glossary) },
  ];
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      chat(messages, 900, true, { reasoning: { enabled: false }, ...(model ? { model } : {}) }), // reasoning tokens made the call slow / truncated (finish_reason=length)
      new Promise<string>((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
    const p = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as Partial<NormalizerLlmOutput>; // the model sometimes fences its JSON
    return {
      ms: Date.now() - started,
      output: {
        language: p.language === "en" || p.language === "other" ? p.language : "sq",
        is_followup: Boolean(p.is_followup),
        changed: Boolean(p.changed),
        standalone_query: typeof p.standalone_query === "string" ? p.standalone_query.replace(/\s+/g, " ").trim() : "",
        corrections: Array.isArray(p.corrections) ? p.corrections.filter((c) => c && typeof c.from === "string" && typeof c.to === "string") : [],
        confidence: typeof p.confidence === "number" ? p.confidence : 0.5,
        notes: typeof p.notes === "string" ? p.notes : "",
      },
    };
  } catch (e) {
    return { output: null, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Every number / KTP number of the original must survive; the rewrite must be non-empty, sane in length and not low-confidence. */
export function validateRewrite(original: string, out: NormalizerLlmOutput): { ok: boolean; reason?: string } {
  if (!out.standalone_query) return { ok: false, reason: "empty rewrite" };
  if (out.standalone_query.length > 400) return { ok: false, reason: "rewrite too long" };
  if (out.confidence < 0.3) return { ok: false, reason: `low confidence ${out.confidence}` };
  const outFolded = foldText(out.standalone_query);
  for (const n of original.match(/\d+(?:[.,\-]\d+)*/g) ?? []) {
    if (!outFolded.includes(foldText(n))) return { ok: false, reason: `number "${n}" was lost` };
  }
  return { ok: true };
}

/** No-LLM fallback for English input: the Albanian corpus terms that match the English words, plus any KTP numbers typed by the user. */
export function glossaryFallbackQuery(query: string): string | null {
  const terms = lookupGlossary(query, 8).map((g) => g.sq);
  if (!terms.length) return null;
  const numbers = query.match(/(?:KTP\s*)?N?\.?\s*\d+-\d+/gi) ?? [];
  return [...terms, ...numbers].join(" ");
}

// ------------------------------------------------------------------ public API
export type QueryNormalization = {
  original: string;
  /** query used for keyword search, rerank, expansion and consensus */
  retrievalQuery: string;
  /** additional probe strings (e.g. the typo-fixed original when the LLM rewrote an Albanian question) */
  extraProbes: string[];
  mode: "none" | "snap" | "llm" | "llm-fallback" | "glossary-fallback";
  language: Language;
  isFollowup: boolean;
  reasons: string[];
  snaps: { from: string; to: string }[];
  corrections: { from: string; to: string }[];
  glossaryTerms: string[];
  droppedTechnicalWords: string[];
  confidence: number | null;
  llmMs: number | null;
  fallbackReason?: string;
  notes?: string;
  /** Jev gate verdict when options.gate was given (null = gate failed, heuristics decided) */
  gate?: QueryGate | null;
};

export async function normalizeKtpQuery(query: string, history: QAPair[] = [], options: { llm?: boolean; timeoutMs?: number; chat?: ChatFn; gate?: GateFn; model?: string } = {}): Promise<QueryNormalization> {
  let analysis = analyzeQuery(query, history);
  const gate = options.gate ? await options.gate(query, history) : undefined;
  if (gate) analysis = applyGate(query, analysis, gate, history.length > 0);
  const repaired = analysis.repairedQuery; // original text with only typo snaps applied
  const base: QueryNormalization = {
    original: query, retrievalQuery: repaired, extraProbes: analysis.snaps.length ? [query] : [],
    mode: analysis.snaps.length ? "snap" : "none", language: analysis.language, isFollowup: false, reasons: analysis.reasons, snaps: analysis.snaps,
    corrections: [], glossaryTerms: [], droppedTechnicalWords: [], confidence: null, llmMs: null,
    ...(gate !== undefined ? { gate } : {}),
  };
  // English / unknown language: the original words only add noise to an Albanian keyword search, so fall back to glossary terms.
  const withoutLlm = (reason: string, mode: QueryNormalization["mode"]): QueryNormalization => {
    if (analysis.language === "sq") return { ...base, mode: base.mode === "none" ? mode : base.mode, fallbackReason: reason };
    const fb = glossaryFallbackQuery(query);
    return fb ? { ...base, retrievalQuery: fb, extraProbes: [], mode: "glossary-fallback", fallbackReason: reason } : { ...base, mode, fallbackReason: reason };
  };
  if (!analysis.needsLlm) return base;
  if (options.llm === false) return withoutLlm("llm disabled", "none");

  // Send the text as typed (never the folded form: folding turns "KTP 8-78" into "ktp 8 78" and breaks the KTP-number scoping).
  const glossary = lookupGlossary(query);
  const { output, ms, error } = await callNormalizerLlm(query, history, glossary, options.timeoutMs ?? 10000, options.chat, options.model);
  base.llmMs = ms;
  base.glossaryTerms = glossary.map((g) => g.sq);
  if (!output) return { ...withoutLlm(error ?? "no output", "llm-fallback"), llmMs: ms, glossaryTerms: base.glossaryTerms };
  const verdict = validateRewrite(query, output);
  if (!verdict.ok) return { ...withoutLlm(verdict.reason ?? "invalid rewrite", "llm-fallback"), llmMs: ms, glossaryTerms: base.glossaryTerms, confidence: output.confidence, notes: output.notes };

  const outFolded = foldText(output.standalone_query);
  const fromWords = new Set(output.corrections.flatMap((c) => foldText(c.from).split(" ")));
  const dropped =
    output.language === "sq"
      ? analysis.snappedQuery.split(" ").filter((t) => t.length >= 5 && (VOCAB.get(t) ?? 0) >= 3 && !fromWords.has(t) && !outFolded.includes(t))
      : [];
  // Union, not replacement: whatever the LLM drops or changes, the user's own (typo-repaired) words are still searched.
  const keepRepaired = output.language === "sq" && foldText(repaired) !== outFolded;
  return {
    ...base,
    mode: "llm",
    retrievalQuery: output.standalone_query,
    extraProbes: keepRepaired ? [repaired] : [],
    language: output.language,
    isFollowup: output.is_followup,
    corrections: output.corrections,
    droppedTechnicalWords: dropped,
    confidence: output.confidence,
    notes: output.notes,
  };
}
