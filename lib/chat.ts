// Conversation memory: message storage + query rewriting for follow-up
// questions, a HyDE retrieval-expansion step (2026-07-29, TS-only -- not
// backported into python-etl/chat.py, which is no longer under active
// development), plus the orchestrating chat() function that ties history +
// rewrite + HyDE + retrieval + generation together.
//
// IMPORTANT: chat()'s call to retrieve() is still blocked by Pinecone's
// exhausted account-wide embedding quota (see plan.md) -- search_records
// embeds the query server-side, same call that's been failing since
// 2026-07-25/26. saveMessage/getHistory/rewriteQuery/generateHypotheticalAnswers
// below have NO Pinecone dependency and are fully testable now. chat() itself
// is written correctly by the same logic as the already-tested Python
// version (plus the new HyDE step), but has NOT been live-tested end-to-end
// -- flagging that explicitly rather than claiming it's verified.

import { pool } from "./retrieve";
import { callLLM, type ChatMessage } from "./llmClient";
import { retrieve } from "./retrieve";
import { generateAnswer, type GenerationResult } from "./generate";

// Appends one message to a session's history. `sequence` isn't auto-assigned
// by Postgres (see the Maintenance flag / sequence-column notes in plan.md --
// `now()` is transaction-time, not per-statement, so it can't reconstruct
// order reliably) -- instead we ask the table itself for the current max
// and add 1, same pattern chat.py uses.
export async function saveMessage(
  sessionId: string,
  role: ChatMessage["role"],
  content: string
): Promise<void> {
  // coalesce(max(sequence), -1) + 1: if this is the FIRST message in the
  // session, max(sequence) is null (no rows yet) -- coalesce swaps that
  // null for -1, so the very first message still gets sequence 0.
  const { rows } = await pool.query(
    "select coalesce(max(sequence), -1) + 1 as next_sequence from chat_messages where session_id = $1",
    [sessionId]
  );
  const nextSequence = rows[0].next_sequence;

  await pool.query(
    "insert into chat_messages (session_id, role, content, sequence) values ($1, $2, $3, $4)",
    [sessionId, role, content, nextSequence]
  );
}

// All messages for a session, in order, shaped exactly like ChatMessage --
// this is what gets fed to rewriteQuery() and (eventually) sent straight to
// an LLM as conversation history.
export async function getHistory(sessionId: string): Promise<ChatMessage[]> {
  const { rows } = await pool.query(
    "select role, content from chat_messages where session_id = $1 order by sequence",
    [sessionId]
  );
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

// Rewrites a context-dependent follow-up ("what about its annexes?") into a
// standalone question ("what about Vendim 610/2022's annexes?"), using
// prior conversation history -- so retrieval gets something it can actually
// search on. Safe to call even when the question is already standalone --
// the model is told to return it unchanged in that case.
export async function rewriteQuery(
  history: ChatMessage[],
  newQuestion: string
): Promise<string> {
  const historyText = history.map((m) => `${m.role}: ${m.content}`).join("\n");
  const prompt =
    "Given this conversation history and a new follow-up question, " +
    "rewrite the follow-up into a standalone question that makes full " +
    "sense on its own, without needing the history. If the follow-up " +
    "is already standalone, return it unchanged. Return ONLY the " +
    "rewritten question, nothing else.\n\n" +
    `History:\n${historyText}\n\nFollow-up question: ${newQuestion}`;

  const result = await callLLM([{ role: "user", content: prompt }]);
  return result.content.trim();
}

// HyDE (Hypothetical Document Embeddings): asks the LLM to imagine up to 5
// short passages that would plausibly ANSWER the question, written like
// real excerpts from a law article/Eurocode clause -- then we search with
// that imagined text instead of the bare question. Reasoning: our chunks
// are declarative legal prose, not question-shaped text, so a fake-but-
// plausible-looking answer often matches the real passage better than the
// question itself does, in embedding space.
//
// Deliberately ONE callLLM() call (not up to 5 separate ones) -- the model
// is free to write as many as 5 short passages inside ITS ONE response;
// they all get embedded together as a single search string, so this adds
// zero extra Pinecone embedding calls versus not using HyDE at all. That
// matters because Pinecone's embedding quota is the exact thing that's
// already been exhausted once this project (see plan.md) -- multiplying
// Pinecone calls per turn was not an option here.
export async function generateHypotheticalAnswers(question: string): Promise<string> {
  const prompt =
    "Write up to 5 short hypothetical passages, in the same language as " +
    "the question, each reading like a real excerpt from an Albanian " +
    "construction law article or Eurocode clause, that would plausibly " +
    "answer this question. These are imagined passages used only to " +
    "improve document search -- they do not need to be factually correct.\n\n" +
    `Question: ${question}`;

  const result = await callLLM([{ role: "user", content: prompt }]);
  const hypotheticalText = result.content.trim();

  // Fallback: if the model returned nothing usable, search with the
  // (already-rewritten) question itself rather than an empty string.
  return hypotheticalText.length > 0 ? hypotheticalText : question;
}

// Deletes every message belonging to one session -- the "clear/start a new
// conversation" action. Backs the DELETE /api/chat/:sessionId route.
export async function deleteSession(sessionId: string): Promise<void> {
  await pool.query("delete from chat_messages where session_id = $1", [sessionId]);
}

// Full conversational turn: rewrite the query using history if any, expand
// it via HyDE, retrieve, generate, and persist both sides of the exchange.
// `lawIds` (2026-08-01, left-sidebar toggle feature): optional search-scope
// filter, passed straight through to retrieve() -- undefined/empty means
// "search everything," same as before this feature existed.
export async function chat(
  sessionId: string,
  question: string,
  lawIds?: string[]
): Promise<GenerationResult> {
  const history = await getHistory(sessionId);
  // Only bother rewriting if there IS history -- a first message has
  // nothing to be context-dependent on, rewriting it would just waste an
  // LLM call for no benefit.
  const standaloneQuestion = history.length > 0 ? await rewriteQuery(history, question) : question;

  // HyDE step: turn the standalone question into imagined-answer text
  // BEFORE searching with it. generateAnswer() below still gets the real
  // original `question`, never this -- the hypothetical text is purely a
  // search aid, same "internal tool, not user-facing" pattern as the
  // rewrite above.
  const hydeQuery = await generateHypotheticalAnswers(standaloneQuestion);

  // Save the user's ORIGINAL question (not the rewritten/HyDE version) --
  // both are internal search aids, not something the user actually typed,
  // so neither should appear in their own visible history.
  await saveMessage(sessionId, "user", question);

  const hits = await retrieve(hydeQuery, 5, "pilot", lawIds);
  const result = await generateAnswer(question, hits);

  await saveMessage(sessionId, "assistant", result.answer);
  return result;
}
