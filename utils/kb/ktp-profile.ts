import { getKtpIndex } from "./pinecone";
import { runTechnicalSearch, type SearchProfile } from "./technical-search";
import {
  getKtpChunksByIds,
  rerankKtpMatches,
  searchKtpLexically,
  type KtpChunk,
} from "./technical-metadata";
import type { QAPair } from "./generate-answer";

function selectKtpPromptMatches(chunks: KtpChunk[], query: string): KtpChunk[] {
  const [first, second] = chunks;
  if (!first) return chunks;

  const directLookup =
    /\b(sa|si|cili|cila|cilat|where|what|which|how|largesia|ndricimi|intensiteti|percaktohet)\b/i.test(query);
  const decisiveTopMatch =
    typeof first.score === "number" &&
    typeof second?.score === "number" &&
    first.score - second.score >= 0.12;
  const highConfidenceLexicalLookup =
    directLookup &&
    first.retrieval_source === "postgres_lexical" &&
    typeof first.score === "number" &&
    first.score >= 1.5;

  if ((directLookup && decisiveTopMatch) || highConfidenceLexicalLookup) {
    return [first];
  }

  return chunks;
}

export const ktpSearchProfile: SearchProfile<KtpChunk> = {
  logName: "ktp",
  scopeDescription: "Albanian KTP national technical design codes",
  hydeDescription: "Albanian KTP national technical design code text, formal engineering-code Albanian",
  getIndex: getKtpIndex,
  lexicalSearch: searchKtpLexically,
  hydrateByIds: getKtpChunksByIds,
  rerankMatches: rerankKtpMatches,
  selectPromptMatches: selectKtpPromptMatches,
  normalizeChunk: (chunk) => ({
    ...chunk,
    instrument_type: "KTP",
    instrument_number: chunk.ktp_number ?? undefined,
  }),
  answerProfile: {
    scopeDescription: "Albanian KTP national technical design codes",
    noMatchText: "No confident match found in the indexed KTP codes.",
    skipStructuredExtractionForSingleChunk: true,
    maxPromptChunks: 7,
    maxExcerptChars: 2200,
    answerMaxTokens: 1200,
    extraRules:
      "- For KTP, prefer the excerpt whose KTP number and point directly answer the user's wording. Avoid citing other KTP documents only because they mention a similar general topic.\n" +
      "- Use 1 citation for simple numeric, definition, or direct procedural lookups. Use multiple citations only when the answer combines rules from multiple points.\n" +
      "- Preserve the user's key subject words in the answer when supported by the excerpt, especially object, direction, distance, lighting, load, intensity, and applicability terms.\n" +
      "- For direct KTP lookup questions, begin with the governed subject and condition from the question/source; do not answer with only the value.\n" +
      "- When answering a distance, lighting, coefficient, or threshold question, state the governed object/location and condition before or in the same sentence as the value.\n" +
      "- Preserve named measurement/classification systems and abbreviations exactly when shown in the source, including MSK-1964.",
  },
};

export function runKtpSearch(query: string, history: QAPair[], documentIds: string[] = []) {
  return runTechnicalSearch<KtpChunk>(query, history, ktpSearchProfile, documentIds);
}
