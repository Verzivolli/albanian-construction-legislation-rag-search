import { chatCompletion, type ChatMessage } from "./openrouter-chat";
import { embedText } from "./embed";
import { generateHydePassage } from "./hyde";
import { generateAnswer, type AnswerProfile, type QAPair, type RetrievedChunk } from "./generate-answer";

export type SearchProfile<T extends RetrievedChunk> = {
  logName: string;
  scopeDescription: string;
  hydeDescription: string;
  answerProfile: AnswerProfile;
  getIndex: () => { query: (args: { vector: number[]; topK: number; includeMetadata: true }) => Promise<{ matches: PineconeMatch[] }> };
  lexicalSearch: (query: string, limit: number, documentIds?: string[]) => Promise<T[]>;
  hydrateByIds: (ids: string[]) => Promise<Map<string, T>>;
  expandContext?: (chunks: T[]) => Promise<T[]>;
  normalizeChunk?: (chunk: T) => T;
  useHyde?: boolean;
  useQueryRewrite?: boolean;
  rerankMatches?: (chunks: T[], query: string) => T[];
  selectPromptMatches?: (chunks: T[], query: string) => T[];
};

type PineconeMatch = {
  id?: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

const VECTOR_TOP_K = 14;
const LEXICAL_TOP_K = 10;
const PROMPT_TOP_K = 12;
const FILTERED_VECTOR_TOP_K = 50;

function compactHistory(history: QAPair[]): string {
  return history
    .slice(-5)
    .map((turn, i) => `Turn ${i + 1}\nQ: ${turn.question}\nA: ${turn.answer}`)
    .join("\n\n");
}

async function rewriteTechnicalQuery(query: string, history: QAPair[], scopeDescription: string): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed || history.length === 0) return trimmed;

  const messages: ChatMessage[] = [
    {
      role: "user",
      content: `Rewrite the user's latest question as a standalone search query for ${scopeDescription} retrieval.

Use chat history only to resolve references and short follow-ups. Do not answer. Do not add new facts.
Preserve code names, clause numbers, KTP numbers, NTC paragraph numbers, and technical terms exactly when present.
Return only the rewritten query.

Chat history:
${compactHistory(history)}

Latest question: ${trimmed}`,
    },
  ];

  try {
    const rewritten = (await chatCompletion(messages, 700)).trim().replace(/^["']|["']$/g, "");
    return rewritten || trimmed;
  } catch (e) {
    console.warn(`[${scopeDescription} search] query rewrite failed; using raw query:`, e);
    return trimmed;
  }
}

function mergeMatches<T extends RetrievedChunk>(matches: T[]): T[] {
  const byId = new Map<string, T>();
  for (const match of matches) {
    const existing = byId.get(match.id);
    if (!existing || (match.score ?? 0) > (existing.score ?? 0)) {
      byId.set(match.id, match);
    }
  }
  return [...byId.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function chunkDocumentId(chunk: RetrievedChunk): string | undefined {
  const value = (chunk as RetrievedChunk & { document_id?: unknown; doc_id?: unknown }).document_id ??
    (chunk as RetrievedChunk & { doc_id?: unknown }).doc_id;
  return typeof value === "string" ? value : undefined;
}

export async function runTechnicalSearch<T extends RetrievedChunk>(
  query: string,
  history: QAPair[],
  profile: SearchProfile<T>,
  documentIds: string[] = [],
) {
  const standaloneQuery =
    profile.useQueryRewrite === false
      ? query.trim()
      : await rewriteTechnicalQuery(query, history, profile.scopeDescription);
  const selectedDocumentIds = [...new Set(documentIds.filter(Boolean))];
  const lexicalPromise = profile.lexicalSearch(standaloneQuery, LEXICAL_TOP_K, selectedDocumentIds);
  const hydePassage = profile.useHyde === false
    ? standaloneQuery
    : await generateHydePassage(`${profile.hydeDescription}\n\nQuestion: ${standaloneQuery}`);
  const [lexicalMatches, vector] = await Promise.all([
    lexicalPromise,
    embedText(hydePassage).catch((e) => {
      console.warn(`[${profile.logName} search] vector embedding failed; using Postgres lexical recall only:`, e);
      return null;
    }),
  ]);

  let vectorMatches: T[] = [];
  if (vector) {
    const vectorResult = await profile.getIndex().query({
      vector,
      topK: selectedDocumentIds.length ? FILTERED_VECTOR_TOP_K : VECTOR_TOP_K,
      includeMetadata: true,
    });
    vectorMatches = vectorResult.matches
      .filter((match): match is PineconeMatch & { id: string } => typeof match.id === "string")
      .map((match) => ({
        id: match.id,
        score: match.score,
        retrieval_source: "pinecone_vector",
        ...match.metadata,
      })) as unknown as T[];
  }

  const recalled = mergeMatches([...lexicalMatches, ...vectorMatches]).filter((match) => {
    if (selectedDocumentIds.length === 0) return true;
    const documentId = chunkDocumentId(match);
    return documentId ? selectedDocumentIds.includes(documentId) : false;
  });
  const pgChunks = await profile.hydrateByIds(recalled.map((match) => match.id));
  const hydrated = recalled.map((match) => {
    const pg = pgChunks.get(match.id);
    const merged = pg
      ? {
          ...match,
          ...pg,
          score: match.score,
          retrieval_source: match.retrieval_source,
        }
      : match;
    return profile.normalizeChunk ? profile.normalizeChunk(merged as T) : (merged as T);
  });

  const expanded = profile.expandContext ? await profile.expandContext(hydrated.slice(0, 8)) : [];
  const mergedMatches = mergeMatches([...hydrated, ...expanded]).filter((match) => {
    if (selectedDocumentIds.length === 0) return true;
    const documentId = chunkDocumentId(match);
    return documentId ? selectedDocumentIds.includes(documentId) : false;
  });
  const rankedMatches = profile.rerankMatches ? profile.rerankMatches(mergedMatches, standaloneQuery) : mergedMatches;
  const matches = (profile.selectPromptMatches ? profile.selectPromptMatches(rankedMatches, standaloneQuery) : rankedMatches).slice(
    0,
    PROMPT_TOP_K,
  );
  const { answer, citations } = await generateAnswer(query, matches, history, profile.answerProfile);

  return { query, standaloneQuery, hydePassage, matches, answer, citations };
}
