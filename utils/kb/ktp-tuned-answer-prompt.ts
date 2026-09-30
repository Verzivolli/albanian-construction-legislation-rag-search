import { excerptText, type QAPair, type RetrievedChunk } from "./generate-answer";
import type { ChatMessage } from "./openrouter-chat";

/**
 * Answer prompt of the tuned / tuned-normalize KTP flows -- system prompt AND user message, both in one place, edit them here.
 * Output shape ({analysis?, answer, citations}) is enforced separately by the strict json_schema in ktp-steps.ts (answerExtraBody).
 *
 * History: until 2026-09-24 the user message came from the shared generate-answer.ts buildAnswerMessages, which carried a
 * legislation-only block ("Structured extraction ... (structured extraction unavailable)" + deadlines/documents drafting rules)
 * and excerpt headers with status/verified/similarity/retrieval-source noise; the system prompt was 20 partly contradictory
 * rules. Replaced after the 80-question failure review (testing/evals/answer-stage-v2/REPORT.md): answers dropped conditions
 * and neighbouring sentences of excerpts they already used, covered only part of wide questions, and once invented an exception.
 */
export function buildKtpTunedSystemPrompt(maxCitations: number, noMatchText: string, withAnalysis = true): string {
  const fields = withAnalysis
    ? `Reply with one JSON object. Fill its fields in this order:
1. "analysis": the excerpts that directly answer the question, at most 12 entries {id, fact}. The fact is at most 40 words: only the clause(s) that answer, copied, WITH their conditions, numbers, units, categories and exceptions. Skip excerpts that are only related.
2. "answer": written from "analysis".
3. "citations": ids of the excerpts the answer uses, at most ${maxCitations}, no others.`
    : `Reply with one JSON object: "answer", and "citations" = ids of the excerpts the answer uses, at most ${maxCitations}, no others.`;
  return `You are KodiAI. You answer questions about the Albanian KTP technical design codes (Kushte Teknike të Projektimit) using ONLY the excerpts in the user message. Do not use general engineering knowledge, Eurocodes or other codes unless an excerpt itself states them.

Each excerpt starts with its [id], the KTP number and the point/section. Its first text line is usually the path document / chapter / section.

Read ALL excerpts before answering. The sentences next to the one that answers often define, limit, extend or make an exception to it (also a Shënim) -- include them.

${fields}

Answer rules:
- Same language as the question.
- Direct lookups (one value, one rule): copy the governing sentence whole -- its object, condition, value, unit and every qualifier. Do not shorten it.
- A value or rule without its condition is wrong. Keep the object, the soil category, the seismic intensity (ballë, MSK-1964), the height / number of storeys, the building or system category and the place where it applies.
- "Kur / në cilat raste / when" questions: give the condition written in the text AND the rule it triggers.
- "Nga çfarë varet / si llogaritet / si përcaktohet" questions: give the factors AND the definition or formula when an excerpt states them.
- Overview questions ("cilat janë", "si ndahen", "llojet", "rregullat kryesore", types / categories / main rules): cover every distinct group the excerpts contain (e.g. classification by hydraulic regime AND by function AND class criteria; a rule AND its exception AND how it is calculated), organised by group, one short line per item. Breadth first: do not spend the answer on the details of one group while another group is missing.
- State prohibitions, limits and exceptions exactly as written. Never infer a permission, exception or consequence the text does not state (no "duke nënkuptuar", "që do të thotë se").
- Copy numbers, units, formulas, symbols, table references and category names exactly. Never compute or extrapolate a value the text does not state.
- If the excerpts cover only part of the question, answer that part and say which part they do not cover.
- Answer "${noMatchText}" with empty citations only when no excerpt addresses the topic at all. A broad question is answered from whatever the excerpts contain.`;
}

/** Excerpt header: id, KTP number, point/section. Title only when the text has no breadcrumb line (which already names the document). */
function formatKtpExcerpt(c: RetrievedChunk, maxExcerptChars: number, query: string): string {
  const where = c.section_number ? `${c.section_level === "point" ? "pika" : c.section_level ?? ""} ${c.section_number}`.trim() : "";
  const text = typeof c.text === "string" ? c.text : "";
  const header = [c.ktp_number ? `KTP ${c.ktp_number}` : "", where, c.context_text ? "" : c.title].filter(Boolean).join(" — ");
  return `[${c.id}] ${header}\n${excerptText(text, maxExcerptChars, query)}`;
}

/** The exact chat messages of the KTP answer call: system prompt, last 5 history turns, then excerpts + question. Pure. */
export function buildKtpAnswerMessages(
  query: string,
  chunks: RetrievedChunk[],
  history: QAPair[],
  systemPrompt: string,
  maxExcerptChars: number,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  for (const turn of history.slice(-5)) {
    messages.push({ role: "user", content: turn.question });
    messages.push({ role: "assistant", content: turn.answer });
  }
  messages.push({
    role: "user",
    content: `Excerpts:\n\n${chunks.map((c) => formatKtpExcerpt(c, maxExcerptChars, query)).join("\n\n")}\n\nQuestion: ${query}`,
  });
  return messages;
}
