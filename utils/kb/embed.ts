/** Embed text via OpenRouter. This must stay on the same model used at ingestion time;
 * switching embedding models requires full re-ingestion. */
export type EmbeddingTelemetryEntry = {
  model: string;
  input_chars: number;
  estimated_tokens: number;
  elapsed_ms: number;
  estimated_cost_usd: number;
};

const EMBEDDING_INPUT_PER_1M_USD = 0.02;
const embeddingTelemetry: EmbeddingTelemetryEntry[] = [];

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function resetEmbeddingTelemetry() {
  embeddingTelemetry.length = 0;
}

export function getEmbeddingTelemetry(): EmbeddingTelemetryEntry[] {
  return [...embeddingTelemetry];
}

export async function embedText(text: string): Promise<number[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_EMBEDDING_MODEL;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  if (!model) throw new Error("OPENROUTER_EMBEDDING_MODEL is not set");

  const started = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter embeddings request failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const estimated_tokens = estimateTokens(text);
  embeddingTelemetry.push({
    model,
    input_chars: text.length,
    estimated_tokens,
    elapsed_ms: Date.now() - started,
    estimated_cost_usd: (estimated_tokens / 1_000_000) * EMBEDDING_INPUT_PER_1M_USD,
  });
  return data.data[0].embedding as number[];
}
