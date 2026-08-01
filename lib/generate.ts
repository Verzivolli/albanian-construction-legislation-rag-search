// Generation step: given a question and the retrieved context chunks, ask
// an LLM to write a grounded answer. TypeScript port of
// python-etl/generate.py.
//
// Citations are NOT extracted from the LLM's response -- they come
// directly from our own retrieval (retrieve.ts already knows exactly which
// article/law backed each chunk). The model's only job is to write a
// coherent answer using the given context, not to correctly self-report
// its own sources.

import { callLLM } from "./llmClient";
import type { RetrievalHit } from "./retrieve";

// FOLLOWUP_MARKER (2026-08-01): asks the model to bolt 3 follow-up
// questions onto the SAME response as the answer, rather than a separate
// callLLM() call (Option B of 2 presented -- Option A, a dedicated small
// call matching the rewriteQuery()/generateHypotheticalAnswers() pattern
// already used elsewhere in chat.ts, was the initial recommendation and
// is noted in plan.md as a later optimization: fewer moving parts, easier
// to reason about, at the cost of one more LLM call per turn). Plain-text
// delimiter chosen over JSON mode -- the 3 fallback providers (Gemini,
// Groq's llama-3.1-8b-instant, OpenRouter's free gpt-oss-20b) aren't all
// guaranteed to produce valid JSON reliably, especially the smaller free
// models; a delimiter is simpler to parse defensively (see
// parseFollowUps below) and degrades gracefully (missing/malformed
// follow-ups just means an empty list, never a broken answer).
const FOLLOWUP_MARKER = "---FOLLOWUP---";

const SYSTEM_PROMPT =
  "You are a legal assistant for Albanian construction law. " +
  "Answer the question using ONLY the context passages provided. " +
  "Each passage is labeled with its citation in square brackets -- refer " +
  'to these labels naturally in your answer (e.g. "sipas Nenit 2, ' +
  'Vendim 610/2022"). If the context doesn\'t contain enough information ' +
  "to answer, say so honestly instead of guessing. Answer in the same " +
  "language as the question.\n\n" +
  `After your answer, on its own line write exactly ${FOLLOWUP_MARKER}, ` +
  "then list exactly 3 short follow-up questions the user might " +
  "naturally ask next, one per line, in the same language as the " +
  "question, with no numbering, bullets, or extra commentary.";

// Turns the array of hits retrieve() returns into one block of text the LLM
// can read, each chunk prefixed with its own citation in brackets --
// e.g. "[Neni 2, Vendim 610/2022]\n<article text>" -- so the model can
// naturally reference that exact label back in its answer.
function buildContextBlock(hits: RetrievalHit[]): string {
  return hits.map((h) => `[${h.citation}]\n${h.text}`).join("\n\n");
}

// Splits the model's raw response into the real answer text and up to 3
// follow-up questions. Defensive by design, not just by comment: if the
// marker is missing entirely (model ignored the instruction, or a
// fallback provider mid-chain answered differently), the whole response
// is treated as the answer and follow-ups is simply an empty array --
// never a broken/truncated answer shown to the user.
function parseFollowUps(raw: string): { answer: string; followUps: string[] } {
  const markerIndex = raw.indexOf(FOLLOWUP_MARKER);
  if (markerIndex === -1) return { answer: raw.trim(), followUps: [] };

  const answer = raw.slice(0, markerIndex).trim();
  const followUps = raw
    .slice(markerIndex + FOLLOWUP_MARKER.length)
    .split("\n")
    // Strips any numbering/bullet the model added anyway despite being
    // asked not to (e.g. "1. ", "- ") -- small models in the fallback
    // chain don't always follow formatting instructions exactly.
    .map((line) => line.replace(/^[\s\-*\d.)]+/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, 3);

  return { answer, followUps };
}

// One citation, now carrying the real article id alongside its display
// label (2026-08-01) -- previously just a string. The id is what lets the
// UI's right-hand reference panel fetch GET /api/articles/:id when a
// citation badge is clicked, instead of it being purely decorative text.
export interface Citation {
  id: string;
  citation: string;
}

// The final shape returned to whatever calls generateAnswer (eventually the
// /api/chat route). Kept as an explicit interface, same reasoning as
// llmClient.ts's LLMResult -- documents the shape, and TypeScript will
// catch a typo'd field name at compile time instead of at runtime.
export interface GenerationResult {
  answer: string;
  citations: Citation[];
  modelUsed: string;
  followUps: string[];
}

export async function generateAnswer(
  queryText: string,
  hits: RetrievalHit[]
): Promise<GenerationResult> {
  const context = buildContextBlock(hits);

  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: `Context:\n${context}\n\nQuestion: ${queryText}` },
  ];

  const result = await callLLM(messages);
  const { answer, followUps } = parseFollowUps(result.content);

  return {
    answer,
    // Citations come from OUR retrieval, not parsed from the model's own
    // text -- same reasoning as generate.py.
    citations: hits.map((h) => ({ id: h.id, citation: h.citation })),
    modelUsed: result.modelUsed,
    followUps,
  };
}
