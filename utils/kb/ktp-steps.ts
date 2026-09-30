/**
 * The tuned / tuned-normalize KTP pipeline as ONE list of steps (single implementation).
 *
 *   normalize (normalize flow only) -> probes -> keyword -> merge_rerank -> expand -> consensus -> final_pool -> prompt -> answer -> citations
 *
 * Each step reads earlier results from the context `ctx` and returns a `patch` of new fields. Because a step's result is
 * exactly that patch, a run can be recorded step by step (testing/lib/step-store.ts), and a later run can restart from ANY
 * step: rebuild `ctx` from the saved patches of the steps before it and run the current code from there
 * (testing/scripts/replay-ktp-step.ts). The LLM transport is injected (`deps.chat`) so it can be recorded, cached or switched off.
 *
 * ktp-flows.ts implements runKtpPgDocConsensusTunedSearch / runKtpPgDocConsensusTunedNormalizeSearch on top of this file.
 */
import {
  searchKtpLexically,
  getKtpContextChunks,
  getKtpPointPrefixContextChunks,
  getKtpSectionRangeContextChunks,
  searchKtpWithinDocuments,
  getKtpRollupAndTableChunks,
  rerankKtpMatches,
  type KtpChunk,
} from "./technical-metadata";
import {
  mergeMatches,
  normalizeKtpChunk,
  applyDocumentConsensusBoost,
  applyDocumentConsensusBoostV2,
  computeDocumentConsensus,
  computeDocumentConsensusV2,
  extractDocumentIds,
  deterministicKtpProbes,
  tunedExtraProbes,
} from "./ktp-pipeline-helpers";
import { runAnswerLlm, resolveAnswer, type AnswerLlmResult, type AnswerProfile, type ChatFn, type Citation, type QAPair } from "./generate-answer";
import { ktpSearchProfile } from "./ktp-profile";
import { buildKtpAnswerMessages, buildKtpTunedSystemPrompt } from "./ktp-tuned-answer-prompt";
import { normalizeKtpQuery, jevQueryGate, type QueryNormalization } from "./ktp-query-normalizer";
import { chatCompletion, type ChatMessage } from "./openrouter-chat";
import { jevDecide } from "./jev";

// ------------------------------------------------------------------ parameters / context
export type PipelineParams = {
  lexicalLimit: number;      // rows per keyword search (one search per probe)
  seedSize: number;          // top-N reranked keyword hits used as expansion seeds
  ctxLimit: number; ctxWindow: number;          // expansion (a) same/sibling sections, +-window positions
  prefixLimit: number;       // expansion (b) sub-points
  rangeForward: number; rangeLimit: number;     // expansion (c) next points
  scopedLimit: number;       // expansion (d) 2nd keyword search inside the seed documents
  rollupLimit: number;       // expansion (e) rollup / table / figure chunks
  maxPromptChunks: number;   // chunks sent to the LLM
  maxExcerptChars: number;   // per-excerpt character cap
  answerMaxTokens: number;
  maxCitations: number;
  /** OpenRouter model id for the ANSWER call only (normaliser + judge keep CHAT_MODEL); unset = CHAT_MODEL. For model comparisons. */
  answerModel?: string;
  /** false = do not send `reasoning:{enabled:false}`. Non-reasoning models (Mistral Small, Qwen3-30B-instruct) list no `reasoning` param, so with require_parameters every endpoint is filtered out (404 "No endpoints found"). Default true. */
  answerDisableReasoning?: boolean;
  /** OpenRouter provider slugs to try first for the ANSWER call (fallbacks stay on). v4.1-flash: Together ~182 tok/s vs DeepInfra ~39 tok/s, the slow tail (testing/evals/model-bench/REPORT.md). */
  answerProviderOrder?: string[];
  /** "jev" = typesafe/jev-1.13 decides language + follow-up before the normalize step's rewrite (ktp-query-normalizer.ts jevQueryGate); unset = heuristics */
  normalizeGate?: "jev";
  /** OpenRouter model id for the normalize (query rewrite) call; unset = CHAT_MODEL */
  normalizeModel?: string;
  /** false = use the old count-only computeDocumentConsensus/applyDocumentConsensusBoost (the majority-vote
   * document gets a flat +0.5 pool-wide, whether or not it agrees with the single top-scoring raw chunk).
   * true (default since 2026-09-22) = computeDocumentConsensusV2/applyDocumentConsensusBoostV2: only trust the
   * majority vote when it agrees with the top-scoring chunk's document; on disagreement, boost nothing. Fixes a
   * traced failure where a large, generically-worded document (KTP 10-78, formula-dense) won the count-only vote
   * 7-1 and buried a short, correct, #1-scoring chunk from a different document (KTP 9-78) past the top-30 cut.
   * Verified on the full 80-question eval set, retrieval-only (no answer LLM call): source-document coverage in
   * the top-30 rose 77/80 -> 79/80, zero regressions across the other 78 questions -- the fix only ever changes
   * behaviour in the exact disagreement case it targets. Old behaviour: `--params '{"consensusRequireTopScoreAgreement":false}'`. */
  consensusRequireTopScoreAgreement: boolean;
  /** complete answer system prompt text replacing utils/kb/ktp-tuned-answer-prompt.ts (prompt experiments: run-ktp-steps.ts --prompt-file) */
  answerSystemPrompt?: string;
  /** true = every chunk is reranked exactly ONCE. The pool then carries the keyword hits' RAW scores (not their first-rerank scores), so
   * final_pool's single rerank gives them the same one round of bonuses the expansion chunks get. false = the original behaviour, where
   * keyword hits are reranked twice (merge_rerank, then again in final_pool) and expansion chunks once.
   * Default true since 2026-09-20 (offline replay on the first-20 baseline: with 30 chunks sent, gold recall 0.87 vs 0.83 for the old ranking; alone at 20 chunks it is neutral on recall and lowers MRR 0.56 -> 0.49). */
  rerankOnce: boolean;
  /** true = answer schema has an `analysis` fact list before `answer` (capped in the prompt: <=12 facts, <=40 words). Default false (answer-stage-v2 test, testing/evals/answer-stage-v2/REPORT.md). */
  answerAnalysis?: boolean;
};

export const DEFAULT_PIPELINE_PARAMS: PipelineParams = {
  lexicalLimit: 28, seedSize: 14, ctxLimit: 28, ctxWindow: 10, prefixLimit: 18, rangeForward: 8, rangeLimit: 22,
  scopedLimit: 18, rollupLimit: 8, maxPromptChunks: 30, maxExcerptChars: 7000, answerMaxTokens: 3600, maxCitations: 13, rerankOnce: true,
  consensusRequireTopScoreAgreement: true,
};

export type ExpansionName = "context" | "pointPrefix" | "sectionRange" | "scoped" | "rollupTable";

/** documentIds = documents the user picked in the chat sidebar; set = keyword search and the final pool are limited to them */
export type PipelineInput = { query: string; history: QAPair[]; documentIds?: string[] };

export type Ctx = {
  input: PipelineInput;
  params: PipelineParams;
  // normalize
  normalization?: QueryNormalization;
  /** query used for retrieval, rerank, expansion and consensus (= input.query unless the normalize step rewrote it) */
  retrievalQuery: string;
  extraProbes: string[];
  // probes / keyword
  probes?: string[];
  perProbe?: { probe: string; rows: KtpChunk[] }[];
  // merge + first rerank
  merged?: KtpChunk[];       // unique chunks after the merge, before the rerank (SQL score order)
  recalled?: KtpChunk[];     // after the first rerank
  seed?: KtpChunk[];
  // expansion / consensus
  expansions?: Record<ExpansionName, KtpChunk[]>;
  pool?: KtpChunk[];         // recalled + all expansion rows, not de-duplicated
  boosted?: KtpChunk[];      // pool after the document-consensus boost
  consensus?: { doc: string | null; votes: Record<string, number>; boostedChunks: number };
  // final pool
  unique?: KtpChunk[];       // boosted, de-duplicated by id (best score), before the second rerank
  ranked?: KtpChunk[];       // after the second rerank: the FULL final ranking
  selected?: KtpChunk[];     // ranked.slice(0, maxPromptChunks) = what the LLM sees
  // answer
  messages?: ChatMessage[];
  llm?: AnswerLlmResult;
  answer?: string;
  citations?: Citation[];
  /** eval only (testing/lib/judge.ts); never set by the production flows */
  judge?: { score: number; passed: boolean; rationale: string; missing: string[] };
};

export type StepDeps = { chat: ChatFn };
export type StepResult = { patch: Partial<Ctx>; meta?: Record<string, unknown> };
export type StepDef = { name: string; run: (ctx: Ctx, deps: StepDeps) => Promise<StepResult> | StepResult };

export const LIVE_DEPS: StepDeps = { chat: chatCompletion };

export function initialCtx(input: PipelineInput, params: Partial<PipelineParams> = {}): Ctx {
  return { input, params: { ...DEFAULT_PIPELINE_PARAMS, ...params }, retrievalQuery: input.query, extraProbes: [] };
}

const uniqueStrings = (values: string[]) => [...new Set(values.filter(Boolean))];

/** Answer profile of the tuned flows: shared KTP profile + the flow's own answer rules. */
export function tunedAnswerProfile(p: PipelineParams): AnswerProfile {
  return {
    ...ktpSearchProfile.answerProfile,
    useStructuredExtraction: false,
    maxPromptChunks: p.maxPromptChunks,
    maxExcerptChars: p.maxExcerptChars,
    answerMaxTokens: p.answerMaxTokens,
    maxCitations: p.maxCitations,
    systemPrompt: p.answerSystemPrompt ?? buildKtpTunedSystemPrompt(p.maxCitations, ktpSearchProfile.answerProfile.noMatchText, p.answerAnalysis === true),
  };
}

const need = <T,>(value: T | undefined, what: string, step: string): T => {
  if (value === undefined) throw new Error(`step '${step}' needs '${what}' from an earlier step`);
  return value;
};

// ------------------------------------------------------------------ steps
export const normalizeStep: StepDef = {
  name: "normalize",
  async run(ctx, deps) {
    const normalization = await normalizeKtpQuery(ctx.input.query, ctx.input.history, {
      chat: deps.chat,
      gate: ctx.params.normalizeGate === "jev" ? jevQueryGate : undefined,
      model: ctx.params.normalizeModel,
    });
    return { patch: { normalization, retrievalQuery: normalization.retrievalQuery, extraProbes: normalization.extraProbes }, meta: { llmMs: normalization.llmMs, mode: normalization.mode, gate: normalization.gate } };
  },
};

export const probesStep: StepDef = {
  name: "probes",
  run(ctx) {
    const q = ctx.retrievalQuery;
    const all = [q, ...ctx.extraProbes, ...deterministicKtpProbes(q), ...tunedExtraProbes(q)];
    // the normalize flow de-duplicates (its extra probe may equal another probe); plain tuned never did
    return { patch: { probes: ctx.normalization ? uniqueStrings(all) : all } };
  },
};

export const keywordStep: StepDef = {
  name: "keyword",
  async run(ctx) {
    const probes = need(ctx.probes, "probes", "keyword");
    const perProbe = await Promise.all(probes.map(async (probe) => ({ probe, rows: await searchKtpLexically(probe, ctx.params.lexicalLimit, ctx.input.documentIds ?? []) })));
    return { patch: { perProbe } };
  },
};

export const mergeRerankStep: StepDef = {
  name: "merge_rerank",
  run(ctx) {
    const perProbe = need(ctx.perProbe, "perProbe", "merge_rerank");
    const merged = mergeMatches(perProbe.flatMap((p) => p.rows));
    const recalled = rerankKtpMatches(merged.map(normalizeKtpChunk), ctx.retrievalQuery);
    return { patch: { merged, recalled, seed: recalled.slice(0, ctx.params.seedSize) } };
  },
};

export const expandStep: StepDef = {
  name: "expand",
  async run(ctx) {
    const seed = need(ctx.seed, "seed", "expand");
    const q = ctx.retrievalQuery, p = ctx.params;
    const ms: Record<string, number> = {};
    const timed = async (name: string, fn: () => Promise<KtpChunk[]>) => { const t = Date.now(); const rows = await fn(); ms[name] = Date.now() - t; return rows; };
    const [context, pointPrefix, sectionRange, scoped, rollupTable] = await Promise.all([
      timed("context", () => getKtpContextChunks(seed, p.ctxLimit, p.ctxWindow)),
      timed("pointPrefix", () => getKtpPointPrefixContextChunks(seed, p.prefixLimit)),
      timed("sectionRange", () => getKtpSectionRangeContextChunks(seed, p.rangeForward, p.rangeLimit)),
      timed("scoped", () => searchKtpWithinDocuments(q, extractDocumentIds(seed.slice(0, 8)), p.scopedLimit)),
      timed("rollupTable", () => getKtpRollupAndTableChunks(seed, p.rollupLimit)),
    ]);
    return { patch: { expansions: { context, pointPrefix, sectionRange, scoped, rollupTable } }, meta: { ms } };
  },
};

export const consensusStep: StepDef = {
  name: "consensus",
  run(ctx) {
    const recalled = need(ctx.recalled, "recalled", "consensus");
    const e = need(ctx.expansions, "expansions", "consensus");
    // rerankOnce: start from the un-reranked merge result so final_pool's rerank is the ONLY one these chunks get (recalled still decides the seed and the consensus vote)
    const keywordHits = ctx.params.rerankOnce ? need(ctx.merged, "merged", "consensus").map(normalizeKtpChunk) : recalled;
    let pool = [
      ...keywordHits,
      ...e.context.map(normalizeKtpChunk),
      ...e.pointPrefix.map(normalizeKtpChunk),
      ...e.sectionRange.map(normalizeKtpChunk),
      ...e.scoped.map(normalizeKtpChunk),
      ...e.rollupTable.map(normalizeKtpChunk),
    ];
    const picked = ctx.input.documentIds?.length ? new Set(ctx.input.documentIds) : null;
    if (picked) pool = pool.filter((c) => picked.has(c.document_id)); // expansions may reach neighbouring documents
    const boosted = ctx.params.consensusRequireTopScoreAgreement
      ? applyDocumentConsensusBoostV2(pool, recalled)
      : applyDocumentConsensusBoost(pool, recalled);
    const votes: Record<string, number> = {};
    for (const c of recalled.slice(0, 8)) if (c.ktp_number) votes[c.ktp_number] = (votes[c.ktp_number] ?? 0) + 1;
    const boostedChunks = boosted.filter((c, i) => (c.score ?? 0) !== (pool[i].score ?? 0)).length;
    const consensusDoc = ctx.params.consensusRequireTopScoreAgreement ? computeDocumentConsensusV2(recalled) : computeDocumentConsensus(recalled);
    return { patch: { pool, boosted, consensus: { doc: consensusDoc, votes, boostedChunks } } };
  },
};

export const finalPoolStep: StepDef = {
  name: "final_pool",
  run(ctx) {
    const boosted = need(ctx.boosted, "boosted", "final_pool");
    const unique = mergeMatches(boosted);
    const ranked = rerankKtpMatches(unique, ctx.retrievalQuery).map(normalizeKtpChunk); // the SECOND rerank (see memory: double-rerank side effect)
    return { patch: { unique, ranked, selected: ranked.slice(0, ctx.params.maxPromptChunks) } };
  },
};

// ------------------------------------------------------------------ Jev rerank (production since 2026-09-26)
/** Jev v2 selection (testing/scripts/jev-v2-retry.ts `--chars 7000 --topx 10 --heur 20`; full 80: 70/80, mean 0.929 vs 69/0.910 for
 * the v1 noul-only selection, testing/evals/jev-v2/REPORT.md). typesafe/jev-1.13 scores every final-pool candidate (0..3 ladder) and
 * decides "send or not" (noul), reading up to 7000 chars per chunk. Selection = Jev top 10 by score, then the heuristic top 20, then
 * every other Jev send by score (de-duplicated, in that order, so promptStep's maxPromptChunks cut never drops the guaranteed picks).
 * If every Jev batch fails, the heuristic ranking is used. */
const JEV_CRITERIA = ["not relevant", "somewhat relevant", "relevant", "highly relevant"];
const JEV_TEXT_CHARS = 7000; // = maxExcerptChars; at 1200 Jev missed facts deeper in the chunk (Q51 "7-10 m" at char 1802)
const JEV_BATCH = 10; // smaller batches: each excerpt can be ~6x longer than in v1
const JEV_TOP = 10;
const HEURISTIC_TOP = 20;

export type JevVerdict = { score: number; send: number };

async function jevBatch(query: string, batch: KtpChunk[]): Promise<Map<string, JevVerdict>> {
  const state: Record<string, string> = { query };
  const questions: Record<string, unknown> = {};
  batch.forEach((c, i) => {
    state[`c${i}`] = c.text.length > JEV_TEXT_CHARS ? c.text.slice(0, JEV_TEXT_CHARS) + "..." : c.text;
    questions[`score${i}`] = { type: "score", instructions: `Score how relevant state.c${i} is to answering state.query, using the given scale.`, criteria: JEV_CRITERIA };
    questions[`send${i}`] = { type: "noul", instructions: `Should state.c${i} be sent to an answer-writing LLM as one of the excerpts used to answer state.query? True only if it directly and materially helps answer the question.` };
  });
  const answers = await jevDecide(state, questions);
  return new Map(batch.map((c, i) => [c.id, { score: (answers[`score${i}`]?.score ?? 0) / (JEV_CRITERIA.length - 1), send: answers[`send${i}`]?.noul ?? 0 }]));
}

/** Up to 3 attempts with 3 s / 6 s backoff, as in the v2 eval; a batch that fails 3 times leaves its candidates unscored. */
async function jevBatchWithRetry(query: string, batch: KtpChunk[]): Promise<Map<string, JevVerdict>> {
  for (let attempt = 1; ; attempt++) {
    try { return await jevBatch(query, batch); } catch {
      if (attempt >= 3) return new Map();
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

/** Jev top 10, then heuristic top 20, then the other Jev sends, de-duplicated; each chunk carries its Jev score. Pure. */
export function selectJevV2(candidates: KtpChunk[], verdicts: Map<string, JevVerdict>, heuristicRanked: KtpChunk[]): KtpChunk[] {
  const byJev = candidates
    .map((c) => ({ c, v: verdicts.get(c.id) ?? { score: 0, send: 0 } }))
    .sort((a, b) => b.v.score - a.v.score || b.v.send - a.v.send);
  const verdictOf = new Map(byJev.map((x) => [x.c.id, x]));
  const order = [
    ...byJev.slice(0, JEV_TOP).map((x) => x.c.id),
    ...heuristicRanked.slice(0, HEURISTIC_TOP).map((c) => c.id),
    ...byJev.filter((x) => x.v.send >= 0.5).map((x) => x.c.id),
  ];
  return [...new Set(order)].flatMap((id) => {
    const x = verdictOf.get(id);
    return x ? [{ ...x.c, score: x.v.score }] : [];
  });
}

export const jevRerankStep: StepDef = {
  name: "jev_rerank",
  async run(ctx, deps) {
    // heuristic final pool first: gives the candidate list (unique) and the heuristic ranking (fallback + top-20 picks)
    const { patch: pool } = await finalPoolStep.run(ctx, deps);
    const candidates = need(pool.unique, "unique", "jev_rerank").map(normalizeKtpChunk);
    const batches: KtpChunk[][] = [];
    for (let i = 0; i < candidates.length; i += JEV_BATCH) batches.push(candidates.slice(i, i + JEV_BATCH));
    // ponytail: all batches at once (median ~77 candidates = ~8 batches); add a concurrency cap if Jev starts rate-limiting
    const verdicts = new Map((await Promise.all(batches.map((b) => jevBatchWithRetry(ctx.retrievalQuery, b)))).flatMap((m) => [...m]));
    if (verdicts.size === 0) return { patch: pool, meta: { jevFallback: true } };
    const selected = selectJevV2(candidates, verdicts, need(pool.ranked, "ranked", "jev_rerank"));
    return { patch: { ...pool, selected }, meta: { candidates: candidates.length, scored: verdicts.size, selected: selected.length } };
  },
};

export const promptStep: StepDef = {
  name: "prompt",
  run(ctx) {
    const selected = need(ctx.selected, "selected", "prompt");
    // the answer model always sees the user's ORIGINAL question (so it answers in the user's language)
    const profile = tunedAnswerProfile(ctx.params);
    return { patch: { messages: buildKtpAnswerMessages(ctx.input.query, selected.slice(0, ctx.params.maxPromptChunks), ctx.input.history, profile.systemPrompt!, ctx.params.maxExcerptChars) } };
  },
};

/** Extra OpenRouter request fields for the answer call. `chunkIds` = the ids in the prompt: citations are restricted to them via an enum. */
export const answerExtraBody = (chunkIds: string[], model?: string, disableReasoning = true, withAnalysis = false, providerOrder?: string[]) => ({
  ...(model ? { model } : {}),
  ...(disableReasoning ? { reasoning: { enabled: false } } : {}),
  // strict schema (overrides json_object mode); require_parameters = only route to providers that enforce it
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "ktp_answer",
      strict: true,
      schema: {
        type: "object",
        properties: {
          // analysis BEFORE answer: the model must walk every excerpt and write down what bears on the question before drafting
          // (single-call fact extraction; answers used to drop conditions / whole groups the prompt contained). Named so it also
          // sorts first: some providers emit keys alphabetically regardless of schema order (seen live 2026-09-24 with "facts").
          ...(withAnalysis ? { analysis: {
            type: "array",
            description: "At most 12 entries, excerpts that directly answer the question. fact = at most 40 words, the answering clause(s) copied with their conditions, numbers and exceptions.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", ...(chunkIds.length ? { enum: chunkIds } : {}) },
                fact: { type: "string" },
              },
              required: ["id", "fact"],
              additionalProperties: false,
            },
          } } : {}),
          answer: {
            type: "string",
            description: "The answer, in the same language as the question, complete, with every condition and exception.",
          },
          citations: {
            type: "array",
            description: "Ids of the excerpts the answer relies on, copied exactly from the bracketed ids in the prompt. Empty array when there is no confident answer. Never invent ids.",
            items: { type: "string", description: "One excerpt id, e.g. ktp-16-78--1.1.3--2", ...(chunkIds.length ? { enum: chunkIds } : {}) },
          },
        },
        required: [...(withAnalysis ? ["analysis"] : []), "answer", "citations"],
        additionalProperties: false,
      },
    },
  },
  provider: { require_parameters: true, ...(providerOrder?.length ? { order: providerOrder, allow_fallbacks: true } : {}) },
});

export const answerStep: StepDef = {
  name: "answer",
  async run(ctx, deps) {
    const messages = need(ctx.messages, "messages", "answer");
    // reasoning off: the model spent up to ~800 hidden tokens per answer (slow, and twice returned null content -> pipeline error)
    const llm = await runAnswerLlm(messages, ctx.params.answerMaxTokens, deps.chat, answerExtraBody(need(ctx.selected, "selected", "answer").map((c) => c.id), ctx.params.answerModel, ctx.params.answerDisableReasoning, ctx.params.answerAnalysis === true, ctx.params.answerProviderOrder));
    return { patch: { llm }, meta: { attempts: llm.attempts.length } };
  },
};

export const citationsStep: StepDef = {
  name: "citations",
  run(ctx) {
    const llm = need(ctx.llm, "llm", "citations");
    const { answer, citations } = resolveAnswer(llm, need(ctx.selected, "selected", "citations"), tunedAnswerProfile(ctx.params));
    return { patch: { answer, citations } };
  },
};

export const TUNED_STEPS: StepDef[] = [probesStep, keywordStep, mergeRerankStep, expandStep, consensusStep, finalPoolStep, promptStep, answerStep, citationsStep];
export const TUNED_NORMALIZE_STEPS: StepDef[] = [normalizeStep, ...TUNED_STEPS];
/** Production KTP pipeline (2026-09-26): tuned-normalize with Jev instead of the heuristic final_pool, and the answer model/settings
 * of the best 80-question run (69/80, mean 0.910, testing/evals/model-bench/REPORT.md). */
export const JEV_STEPS: StepDef[] = TUNED_NORMALIZE_STEPS.map((s) => (s === finalPoolStep ? jevRerankStep : s));
export const JEV_PARAMS: Partial<PipelineParams> = { answerModel: "deepseek/deepseek-v4.1-flash", answerAnalysis: true, answerProviderOrder: ["together"], normalizeGate: "jev" }; // rewrite stays on CHAT_MODEL (deepseek-v4-flash): qwen3.5-flash ignored the no-new-topic / KTP-number rules (2026-09-26)

// ------------------------------------------------------------------ runner
export type StepHooks = {
  /** called right before every step (lets a recorder attribute LLM calls to the step that makes them) */
  beforeStep?: (step: string) => void;
  /** called after every step with its result and wall time */
  onStep?: (step: string, result: StepResult, ms: number) => void | Promise<void>;
  /** stop after this step (e.g. "prompt" to stay free of LLM calls) */
  stopAfter?: string;
};

/** Runs `steps` in order on `ctx` (mutated). To replay, pass a ctx rebuilt from saved patches and only the remaining steps. */
export async function runPipeline(steps: StepDef[], ctx: Ctx, deps: StepDeps = LIVE_DEPS, hooks: StepHooks = {}): Promise<Ctx> {
  for (const step of steps) {
    hooks.beforeStep?.(step.name);
    const started = Date.now();
    const result = await step.run(ctx, deps);
    Object.assign(ctx, result.patch);
    await hooks.onStep?.(step.name, result, Date.now() - started);
    if (hooks.stopAfter === step.name) break;
  }
  return ctx;
}

/** The value the chat route / eval harness expect from a flow. */
export function flowResult(ctx: Ctx) {
  return {
    query: ctx.input.query,
    standaloneQuery: ctx.normalization ? ctx.retrievalQuery : ctx.input.query.trim(),
    hydePassage: null,
    matches: ctx.selected ?? [],
    answer: ctx.answer ?? "",
    citations: ctx.citations ?? [],
    ...(ctx.normalization ? { normalization: ctx.normalization } : {}),
  };
}
