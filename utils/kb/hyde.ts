import { chatCompletion } from "./openrouter-chat";

/** HyDE query expansion (docs/product/UX-EUROCODE-RETRIEVAL.md, locked decision, applies to
 * module A per SCOPE.md's margin analysis too). A short user query embeds far from how real
 * legal-clause text is phrased; generating a hypothetical passage in that register first and
 * embedding *that* bridges the gap. Not fully accurate by design — only used for retrieval. */
export async function generateHydePassage(query: string): Promise<string> {
  try {
    return await chatCompletion(
      [
        {
          role: "user",
          content: `You are drafting a hypothetical excerpt from an Albanian construction law, VKM (Council of Ministers decision), or national design code (KTP), in the register those documents are actually written in (formal, article/neni-numbered, administrative Albanian legal style). This hypothetical passage will be used only to improve semantic search retrieval — it does not need to be factually correct, only representative of what a real matching passage would look like.

User's question: "${query}"

Write a short (2-4 sentence) hypothetical passage that a real, correct answer to this question might look like, in whichever language (English or Albanian) best matches the register of the actual source material. Output only the passage, no preamble.`,
        },
      ],
      800,
    );
  } catch (e) {
    console.warn("[legislation search] HyDE failed; embedding raw query instead:", e);
    return query;
  }
}
