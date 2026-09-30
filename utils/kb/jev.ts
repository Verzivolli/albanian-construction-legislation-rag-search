/** typesafe/jev-1.13 via OpenRouter's Decisions API: typed decisions only, no free text.
 * Question types: noul {instructions} -> {noul: p(yes)}; choice {instructions, criteria: {option: description}} -> {choice, probabilities};
 * score {instructions, criteria: string[] (ordered)} -> {score: level index}. Throws on a non-200 / answer-less reply. */
export const JEV_MODEL = "typesafe/jev-1.13";

export type JevAnswer = { type?: string; noul?: number; score?: number; choice?: string; probabilities?: Record<string, number> };

export async function jevDecide(state: Record<string, string>, questions: Record<string, unknown>): Promise<Record<string, JevAnswer>> {
  const res = await fetch("https://openrouter.ai/api/alpha/decisions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }),
  });
  const d = (await res.json()) as { answers?: Record<string, JevAnswer> };
  if (!res.ok || !d.answers) throw new Error(`jev call failed (${res.status})`);
  return d.answers;
}
