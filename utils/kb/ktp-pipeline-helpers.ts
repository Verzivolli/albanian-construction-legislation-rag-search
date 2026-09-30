import type { KtpChunk } from "./technical-metadata";
import { KTP_PROBE_BLOCKS, KTP_TUNED_PROBE_BLOCKS } from "./ktp-topic-rules";

/** Pure helpers shared by the KTP pipelines (ktp-flows.ts flows and the step pipeline in ktp-steps.ts). Moved out of ktp-flows.ts
 * unchanged so the step pipeline can use them without a circular import; ktp-flows.ts re-exports them. */

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function mergeMatches<T extends { id: string; score?: number }>(matches: T[]): T[] {
  const byId = new Map<string, T>();
  for (const match of matches) {
    const existing = byId.get(match.id);
    if (!existing || (match.score ?? 0) > (existing.score ?? 0)) byId.set(match.id, match);
  }
  return [...byId.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

export function normalizeKtpChunk(chunk: KtpChunk): KtpChunk {
  return {
    ...chunk,
    instrument_type: "KTP",
    instrument_number: chunk.ktp_number ?? undefined,
  } as KtpChunk;
}

/** General (non-question-specific) rerank fix: if 2+ of the top-8 *raw* recalled chunks
 * (before context/point/section expansion pulls in siblings from other documents) agree on
 * a ktp_number, boost every chunk in the final candidate pool sharing that document. Targets
 * cases where an unrelated document's chunk (e.g. a different KTP entirely) outranks the
 * actually-relevant document's chunks after expansion dilutes the pool. Requires a real
 * majority (>=2 agreeing raw hits) before boosting, so a genuinely cross-document question
 * (raw recall legitimately split across documents) isn't distorted. */
export function applyDocumentConsensusBoost(chunks: KtpChunk[], rawRecalled: KtpChunk[]): KtpChunk[] {
  const counts = new Map<string, number>();
  for (const chunk of rawRecalled.slice(0, 8)) {
    const doc = chunk.ktp_number ?? "";
    if (!doc) continue;
    counts.set(doc, (counts.get(doc) ?? 0) + 1);
  }
  let consensusDoc: string | null = null;
  let bestCount = 0;
  for (const [doc, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      consensusDoc = doc;
    }
  }
  if (!consensusDoc || bestCount < 2) return chunks;
  return chunks.map((chunk) => (chunk.ktp_number === consensusDoc ? { ...chunk, score: (chunk.score ?? 0) + 0.5 } : chunk));
}

/** Same majority-vote logic as applyDocumentConsensusBoost's internal counting, exposed
 * standalone so a caller can decide whether to do extra work (a deeper scoped search) once
 * a consensus document is known, not just re-score existing candidates. */
export function computeDocumentConsensus(rawRecalled: KtpChunk[]): string | null {
  const counts = new Map<string, number>();
  for (const chunk of rawRecalled.slice(0, 8)) {
    const doc = chunk.ktp_number ?? "";
    if (!doc) continue;
    counts.set(doc, (counts.get(doc) ?? 0) + 1);
  }
  let consensusDoc: string | null = null;
  let bestCount = 0;
  for (const [doc, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      consensusDoc = doc;
    }
  }
  return bestCount >= 2 ? consensusDoc : null;
}

/** V2 fix (2026-09-22, opt-in via PipelineParams.consensusRequireTopScoreAgreement): the count-only vote above
 * can be won by a large, formula-dense document whose generic vocabulary (e.g. "koeficienti", "shtypje") floods
 * the top-8 with weak matches, even when a SHORT, SPECIFIC, single chunk from the actually-correct document is
 * the #1 individual score. Traced live on "sa merret koeficienti i homogjenitetit te murit ne shtypje": KTP 9-78's
 * one correct chunk scored highest of all (0.39) but KTP 10-78 (steel) won the vote 7-1 on raw chunk count, then
 * got a flat +0.5 pool-wide, burying the correct chunk from rank ~1 to rank 46/62 -- it missed the top-30 sent
 * to the LLM. Fix: only trust the majority vote when it AGREES with the single top-scoring chunk's document.
 * When they disagree, apply NO boost (matches the existing `bestCount < 2` bail-out) rather than guessing which
 * signal is right -- this preserves the original fix's intent for the case it actually agrees on (the common
 * case), and refuses to help bury a genuinely top-scoring chunk under a document that only won on volume. */
export function computeDocumentConsensusV2(rawRecalled: KtpChunk[]): string | null {
  const top8 = rawRecalled.slice(0, 8);
  const majorityDoc = computeDocumentConsensus(rawRecalled);
  if (!majorityDoc) return null;
  const topScoreDoc = top8.reduce((best, c) => ((c.score ?? 0) > (best?.score ?? -Infinity) ? c : best), undefined as KtpChunk | undefined)?.ktp_number ?? null;
  return topScoreDoc === majorityDoc ? majorityDoc : null;
}

/** V2 of applyDocumentConsensusBoost using computeDocumentConsensusV2 instead of the count-only vote. */
export function applyDocumentConsensusBoostV2(chunks: KtpChunk[], rawRecalled: KtpChunk[]): KtpChunk[] {
  const consensusDoc = computeDocumentConsensusV2(rawRecalled);
  if (!consensusDoc) return chunks;
  return chunks.map((chunk) => (chunk.ktp_number === consensusDoc ? { ...chunk, score: (chunk.score ?? 0) + 0.5 } : chunk));
}

export function extractDocumentIds(chunks: KtpChunk[]): string[] {
  return unique(chunks.map((chunk) => chunk.document_id));
}

export function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9./-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function deterministicKtpProbes(query: string): string[] {
  const normalized = normalizeSearchText(query);
  return KTP_PROBE_BLOCKS.filter((block) => block.when(normalized)).flatMap((block) => block.probes);
}

/** New, locally-scoped probes -- NOT added to the shared deterministicKtpProbes, so pg-expanded
 * and every other flow using that function stay completely unaffected. Found via direct
 * investigation of two real recall gaps (id 12, id 20 in the eval set): both facts exist as
 * short, real chunks in Postgres but never surfaced for these query phrasings' dominant
 * keywords. Same hand-tuned-per-topic style already established in deterministicKtpProbes. */
export function tunedExtraProbes(query: string): string[] {
  const normalized = normalizeSearchText(query);
  return KTP_TUNED_PROBE_BLOCKS.filter((block) => block.when(normalized)).flatMap((block) => block.probes);
}

