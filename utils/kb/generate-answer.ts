import { chatCompletion, type ChatMessage } from "./openrouter-chat";

export type RetrievedChunk = {
  id: string;
  score?: number;
  [key: string]: unknown;
};

export type QAPair = { question: string; answer: string };

export type Citation = {
  id: string;
  instrument_type?: string;
  instrument_number?: string;
  ktp_number?: string;
  document?: string;
  ntc_version?: string;
  title?: string;
  status?: string;
  legal_status?: string;
  last_verified?: string;
  section_level?: string;
  section_number?: string;
  section_name?: string;
  source_file?: string;
};

// TODO: to be later set (user, 2026-08-15) — exposed as a constant so it's a one-line change,
// not a re-plumb, once a real per-tier/per-plan value is decided.
export const MAX_CITATIONS = 5;
const MAX_EXCERPT_CHARS = 6500;

export type AnswerProfile = {
  scopeDescription: string;
  noMatchText: string;
  extraRules?: string;
  /** complete system prompt; when set it replaces the generic one built from scopeDescription/noMatchText/extraRules */
  systemPrompt?: string;
  useStructuredExtraction?: boolean;
  skipStructuredExtractionForSingleChunk?: boolean;
  maxPromptChunks?: number;
  maxExcerptChars?: number;
  answerMaxTokens?: number;
  maxCitations?: number;
};

function buildCorpusSystemPrompt(profile: AnswerProfile): string {
  const maxCitations = profile.maxCitations ?? MAX_CITATIONS;
  return `You are KodiAI, a compliance-grade search assistant over ${profile.scopeDescription}. You answer ONLY from the numbered source excerpts provided in each turn -- never from general knowledge.

Excerpts are listed in retrieval order. The score is a recall signal, not proof that the excerpt answers the question. Judge the text itself.

Respond with a single JSON object, no text outside it:
{
  "answer": "<your answer, same language as the question when practical, concise but complete>",
  "citations": ["<excerpt id>", "..."]
}

Rules:
- Every claim in "answer" must be supported by one of the cited excerpts.
- Cite only excerpts that directly support the answer.
- Preserve concrete limits, formulas, thresholds, exceptions, document scope, and applicability conditions.
- For NTC/Circolare, distinguish binding NTC text from Circolare commentary when both are present.
- For KTP, mention the KTP number and point/section when available; do not modernize or replace it with Eurocode rules unless the excerpt itself does that.
- Maximum ${maxCitations} citations. Pick the most load-bearing excerpts.
- If the excerpts do not confidently answer the question, say "${profile.noMatchText}" and return an empty "citations" array.
${profile.extraRules ?? ""}`;
}

const SYSTEM_PROMPT = `You are KodiAI, a compliance-grade search assistant over Albanian construction legislation, VKMs, and national design codes (KTP). You answer ONLY from the numbered source excerpts provided in each turn — never from general knowledge.

Excerpts are listed in order of embedding cosine similarity to the question (highest first), with the similarity score shown next to each one. This is a semantic-closeness signal only, not a judged relevance ranking (no re-ranking/cross-encoder pass is applied) — a lower-similarity excerpt can still be the actually correct source, and a high-similarity one can be topically close but wrong. Use the scores as a hint, not ground truth; judge each excerpt on its actual content against the question.

Respond with a single JSON object, no text outside it:
{
  "answer": "<your answer, same language as the question (English or Albanian), concise — a compliance lookup, not an essay>",
  "citations": ["<excerpt id>", "..."]
}

Rules:
- "citations" holds the bracketed ids (e.g. "ligj-9780-16-7-2007--neni-1--0") of excerpts you actually relied on — every claim in "answer" must be backed by one of them. Do not invent ids not present in the excerpts.
- Cite only excerpts that directly support a sentence in the answer. Do not cite nearby, procedural, opposite-rule, or merely related articles unless the answer explicitly uses their rule.
- For list/category questions, preserve the rule's limiting conditions and thresholds before listing examples (e.g. whether a permit/declaration is required, whether structural/load-bearing elements may be affected, deadlines, area/height/value limits).
- If an excerpt states "pa u pajisur me leje ndërtimi", "pa paraqitur deklaratë paraprake", or similar permit/declaration status, repeat that status explicitly in the answer.
- When a structured extraction is provided, treat its "Must not omit", "Conditions", "Deadlines", and relevant "Required/listed items" as a completeness checklist. Do not compress the final answer so much that these legally material details disappear.
- Maximum ${MAX_CITATIONS} citations. Pick the ${MAX_CITATIONS} most load-bearing excerpts, not just the first ${MAX_CITATIONS} you saw.
- If none of the provided excerpts confidently answer the question, say so explicitly in "answer" (e.g. "No confident match found in the indexed legislation.") and return an empty "citations" array — do not guess or fill gaps with general knowledge. A wrong citation is worse than an honest empty answer.
- Each excerpt's "status" (when shown) is its legal_status (in-force / amended / repealed) if known — not all excerpts have it tracked yet. Prefer in-force sources; if you must cite an amended/repealed one because it's the only match, say so in "answer".
- Each excerpt's "verified" date (when shown) is when its legal_status was last checked against the source — not a freshness guarantee on the text itself. Do not mention it in "answer" unless the question is specifically about currency/recency.`;

const EXTRACTION_PROMPT = `You extract structured legal facts from numbered source excerpts before answer drafting.

Return a compact checklist with these headings:
Relevant ids:
Direct answer:
Conditions:
Required/listed items:
Deadlines:
Exceptions:
Must not omit:

Rules:
- Extract only facts directly supported by the excerpts.
- Prefer the article whose title/section directly matches the question.
- For list/category questions, include the governing condition before examples.
- Capture exact deadlines, time units, thresholds, permit/declaration status, and structural/load-bearing limitations.
- If the excerpts do not answer, say "No supported facts".`;

function normalizePromptSearchText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function excerptText(text: string, maxExcerptChars: number, query?: string): string {
  if (text.length <= maxExcerptChars) return text;

  const normalizedText = normalizePromptSearchText(text);
  const terms = query
    ? normalizePromptSearchText(query)
        .split(" ")
        .filter((term) => term.length >= 3 && !/^\d+$/.test(term))
        .sort((a, b) => b.length - a.length)
    : [];

  if (terms.length) {
    const candidateIndexes: number[] = [];
    for (const term of terms) {
      let index = normalizedText.indexOf(term);
      let guard = 0;
      while (index >= 0 && guard < 80) {
        candidateIndexes.push(index);
        index = normalizedText.indexOf(term, index + term.length);
        guard++;
      }
    }

    if (candidateIndexes.length) {
      const normalizedWindow = Math.max(600, Math.floor((maxExcerptChars / text.length) * normalizedText.length * 0.55));
      const best = candidateIndexes
        .map((index) => {
          const before = Math.max(0, index - Math.floor(normalizedWindow / 2));
          const after = Math.min(normalizedText.length, before + normalizedWindow);
          const window = normalizedText.slice(before, after);
          const score = terms.reduce((sum, term) => {
            const matches = window.match(new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"));
            return sum + (matches?.length ?? 0);
          }, 0);
          return { index, score };
        })
        .sort((a, b) => b.score - a.score || a.index - b.index)[0];

      const ratio = normalizedText.length ? best.index / normalizedText.length : 0;
      const center = Math.max(0, Math.min(text.length - 1, Math.floor(text.length * ratio)));
      const introChars = Math.min(2200, Math.floor(maxExcerptChars * 0.35));
      const focusChars = Math.max(1000, maxExcerptChars - introChars - 180);
      const focusStart = Math.max(0, center - Math.floor(focusChars * 0.4));
      const focusEnd = Math.min(text.length, focusStart + focusChars);

      if (focusStart <= introChars + 300) {
        return `${text.slice(0, maxExcerptChars - 120)}\n\n[excerpt after omitted]`;
      }

      return `${text.slice(0, introChars)}\n\n[excerpt middle omitted]\n\n${text.slice(focusStart, focusEnd)}${
        focusEnd < text.length ? "\n\n[excerpt after omitted]" : ""
      }`;
    }
  }

  return `${text.slice(0, maxExcerptChars - 700)}\n\n[excerpt shortened]\n\n${text.slice(-600)}`;
}

function formatChunksForPrompt(chunks: RetrievedChunk[], maxExcerptChars = MAX_EXCERPT_CHARS, query?: string): string {
  return chunks
    .map((c) => {
      const instrument = [c.instrument_type, c.instrument_number].filter(Boolean).join(" ");
      const section =
        c.section_level && c.section_number
          ? `${c.section_level} ${c.section_number}${c.section_name ? `: ${c.section_name}` : ""}`
          : "";
      const status = c.legal_status || c.status ? `status=${c.legal_status ?? c.status}` : "";
      const verified = c.last_verified ? `verified=${c.last_verified}` : "";
      const similarity = typeof c.score === "number" ? `similarity=${c.score.toFixed(3)}` : "";
      const source = c.retrieval_source ? `source=${c.retrieval_source}` : "";
      const header = [instrument, section, c.title, status, verified, similarity, source].filter(Boolean).join(" — ");
      const text = typeof c.text === "string" ? c.text : "";
      const excerpt = excerptText(text, maxExcerptChars, query);
      return `[${c.id}] (${header})\n${excerpt}`;
    })
    .join("\n\n");
}

/** Same signature as chatCompletion; lets callers (step recorder, replay, tests) inject their own transport / cache. */
export type ChatFn = (messages: ChatMessage[], maxTokens: number, json: boolean, extraBody?: Record<string, unknown>) => Promise<string>;

/** JSON-mode call with one automatic retry at double the budget when the model ran out of tokens (finish_reason=length). */
export async function chatJson(messages: ChatMessage[], maxTokens: number, chat: ChatFn = chatCompletion, extraBody?: Record<string, unknown>): Promise<string> {
  try {
    return await chat(messages, maxTokens, true, extraBody);
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (!message.includes("finish_reason=length")) throw e;
    return chat(messages, maxTokens * 2, true, extraBody);
  }
}

async function extractStructuredFacts(
  query: string,
  chunks: RetrievedChunk[],
  history: QAPair[],
  maxExcerptChars = MAX_EXCERPT_CHARS,
): Promise<string | null> {
  const messages: ChatMessage[] = [{ role: "system", content: EXTRACTION_PROMPT }];
  for (const turn of history.slice(-3)) {
    messages.push({ role: "user", content: turn.question });
    messages.push({ role: "assistant", content: turn.answer });
  }
  messages.push({
    role: "user",
    content: `Source excerpts:\n\n${formatChunksForPrompt(chunks.slice(0, 8), maxExcerptChars, query)}\n\nQuestion: ${query}`,
  });

  try {
    return await chatCompletion(messages, 1600);
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (!message.includes("finish_reason=length")) {
      console.warn("[legislation search] structured extraction failed; answering from excerpts only:", e);
      return null;
    }
    try {
      return await chatCompletion(messages, 3000);
    } catch (retryError) {
      console.warn("[legislation search] structured extraction retry failed; answering from excerpts only:", retryError);
      return null;
    }
  }
}

/** The exact chat messages generateAnswer sends: system prompt, last 5 history turns, then structured facts + excerpts + question.
 * Pure (no network) so the prompt can be saved and inspected as its own pipeline step. */
export function buildAnswerMessages(
  query: string,
  chunks: RetrievedChunk[],
  history: QAPair[] = [],
  profile?: AnswerProfile,
  structuredFacts: string | null = null,
): ChatMessage[] {
  const maxExcerptChars = profile?.maxExcerptChars ?? MAX_EXCERPT_CHARS;
  const promptChunks = chunks.slice(0, profile?.maxPromptChunks ?? chunks.length);
  const messages: ChatMessage[] = [{ role: "system", content: profile?.systemPrompt ?? (profile ? buildCorpusSystemPrompt(profile) : SYSTEM_PROMPT) }];

  for (const turn of history.slice(-5)) {
    messages.push({ role: "user", content: turn.question });
    messages.push({ role: "assistant", content: turn.answer });
  }

  messages.push({
    role: "user",
    content: `Structured extraction from the excerpts (use it as a completeness checklist; source excerpts remain authoritative):
${structuredFacts ?? "(structured extraction unavailable)"}

Drafting requirement:
- Include all legally material conditions, deadlines, thresholds, and exclusions from the checklist when they answer the question.
- If the user asks for a list, state the governing rule/condition first, then list the items.
- If the question asks "how often", "how many days", "what documents", or "criteria", include the concrete number/document/category names, not only a summary.

Source excerpts:

${formatChunksForPrompt(promptChunks, maxExcerptChars, query)}

Question: ${query}`,
  });
  return messages;
}

export type AnswerLlmResult = {
  /** last raw model reply */
  raw: string;
  /** parsed JSON object, or null when the reply was not a JSON object */
  parsed: { answer?: unknown; citations?: unknown } | null;
  attempts: { maxTokens: number; raw?: string; error?: string }[];
};

/** The answer LLM call: JSON mode, one retry at 4800 tokens when the first attempt fails -- either the reply
 * wasn't valid JSON, or the call itself threw (network error, or OpenRouter's upstream-provider-crashed shape:
 * HTTP 200 with finish_reason="error" and garbage `content`, seen live on qwen3.5-flash-02-23 via its sole
 * structured-output provider Alibaba, which has no failover). The first attempt used to be unguarded, so a
 * thrown error there crashed the whole call (HTTP 500) instead of getting this same retry. */
export async function runAnswerLlm(messages: ChatMessage[], maxTokens: number, chat: ChatFn = chatCompletion, extraBody?: Record<string, unknown>): Promise<AnswerLlmResult> {
  const attempts: AnswerLlmResult["attempts"] = [];
  const attempt = async (tokens: number) => {
    const raw = await chatJson(messages, tokens, chat, extraBody);
    attempts.push({ maxTokens: tokens, raw });
    // some providers wrap the (valid) JSON in a ```json fence even in json_schema mode -- strip it instead of burning retries
    const parsed = asObject(JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")));
    // valid JSON that is not an object (seen live on qwen3.5-flash/Alibaba: the bare string fragment `"answer\": "`) -> retry
    if (!parsed) throw new Error("answer reply is not a JSON object");
    return { raw, parsed, attempts };
  };
  try {
    return await attempt(maxTokens);
  } catch (e) {
    if (attempts.length === 0) attempts.push({ maxTokens, error: e instanceof Error ? e.message : String(e) }); // the call itself threw before pushing a raw reply
  }
  try {
    return await attempt(4800);
  } catch (e) {
    // Second attempt also failed (bad JSON or another thrown error) -- caller falls back to the raw text (if any) with no citations.
    const raw = attempts[attempts.length - 1]?.raw ?? "";
    attempts.push({ maxTokens: 4800, error: e instanceof Error ? e.message : String(e) });
    return { raw, parsed: null, attempts };
  }
}

function asObject(x: unknown): { answer?: unknown; citations?: unknown } | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as { answer?: unknown; citations?: unknown }) : null;
}

/** Turns the model reply into {answer, citations}: ids not present in `chunks` are dropped, at most maxCitations are kept. Pure. */
export function resolveAnswer(llm: Pick<AnswerLlmResult, "raw" | "parsed">, chunks: RetrievedChunk[], profile?: AnswerProfile): { answer: string; citations: Citation[] } {
  const parsed = llm.parsed;
  if (!parsed) return { answer: llm.raw, citations: [] };

  const answer = typeof parsed.answer === "string" ? parsed.answer : "";
  const citedIds = new Set(
    (Array.isArray(parsed.citations) ? parsed.citations : [])
      .filter((id): id is string => typeof id === "string")
      .slice(0, profile?.maxCitations ?? MAX_CITATIONS),
  );

  const byId = new Map(chunks.map((c) => [c.id, c]));
  const citations: Citation[] = [...citedIds]
    .map((id) => byId.get(id))
    .filter((c): c is RetrievedChunk => c !== undefined)
    .map((c) => ({
      id: c.id,
      instrument_type: c.instrument_type as string | undefined,
      instrument_number: c.instrument_number as string | undefined,
      ktp_number: c.ktp_number as string | undefined,
      document: c.document as string | undefined,
      ntc_version: c.ntc_version as string | undefined,
      title: c.title as string | undefined,
      status: c.status as string | undefined,
      legal_status: c.legal_status as string | undefined,
      last_verified: c.last_verified as string | undefined,
      section_level: c.section_level as string | undefined,
      section_number: c.section_number as string | undefined,
      section_name: c.section_name as string | undefined,
      source_file: c.source_file as string | undefined,
    }));

  return { answer, citations };
}

/** Grounded generation with citations. `history` is the last-5-turns session context the
 * caller passes in — this function does not read or write any server-side store, matching
 * the "temporary session, no server-side memory" requirement: the client owns the history. */
export async function generateAnswer(
  query: string,
  chunks: RetrievedChunk[],
  history: QAPair[] = [],
  profile?: AnswerProfile,
): Promise<{ answer: string; citations: Citation[] }> {
  const maxExcerptChars = profile?.maxExcerptChars ?? MAX_EXCERPT_CHARS;
  const promptChunks = chunks.slice(0, profile?.maxPromptChunks ?? chunks.length);
  const structuredFacts =
    profile?.useStructuredExtraction === false ||
    (profile?.skipStructuredExtractionForSingleChunk === true && promptChunks.length <= 1)
      ? null
      : await extractStructuredFacts(query, promptChunks, history, maxExcerptChars);
  const messages = buildAnswerMessages(query, chunks, history, profile, structuredFacts);
  const llm = await runAnswerLlm(messages, profile?.answerMaxTokens ?? 2400);
  return resolveAnswer(llm, chunks, profile);
}
