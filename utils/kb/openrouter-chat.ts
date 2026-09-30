export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export const CHAT_MODEL = "deepseek/deepseek-v4-flash";

export type ChatUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
};

export type ChatCompletionResult = {
  content: string;
  usage: ChatUsage;
  elapsed_ms: number;
  /** OpenRouter provider that served the call (e.g. "Alibaba"), when returned */
  provider?: string;
};

export type ChatTelemetryEntry = ChatUsage & {
  model: string;
  elapsed_ms: number;
  /** OpenRouter provider that served the call (e.g. "Alibaba"), when returned */
  provider?: string;
  estimated_cost_usd: number;
};

const DEEPSEEK_V4_FLASH_INPUT_PER_1M_USD = 0.0786;
const DEEPSEEK_V4_FLASH_OUTPUT_PER_1M_USD = 0.1572;

export function estimateChatCostUsd(usage: ChatUsage): number {
  if (typeof usage.cost_usd === "number") return usage.cost_usd;
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  return (input / 1_000_000) * DEEPSEEK_V4_FLASH_INPUT_PER_1M_USD +
    (output / 1_000_000) * DEEPSEEK_V4_FLASH_OUTPUT_PER_1M_USD;
}

const chatTelemetry: ChatTelemetryEntry[] = [];

export function recordChatTelemetry(usage: ChatUsage, elapsed_ms: number): void {
  chatTelemetry.push({
    ...usage,
    model: CHAT_MODEL,
    elapsed_ms,
    estimated_cost_usd: estimateChatCostUsd(usage),
  });
}

export function resetChatTelemetry() {
  chatTelemetry.length = 0;
}

export function getChatTelemetry(): ChatTelemetryEntry[] {
  return [...chatTelemetry];
}

/** Chat completion via OpenRouter — same vendor/credential as embeddings, one fewer
 * dependency than a separate direct Anthropic API key. See docs/product/TECH-STACK.md
 * "LLM calls" for why this model was picked over direct Claude.
 * `json: true` requests OpenRouter/deepseek's JSON object mode (OpenAI-compatible
 * `response_format`) — used by generate-answer.ts to get structured {answer, citations}. */
export async function chatCompletion(
  messages: ChatMessage[],
  maxTokens = 500,
  json = false,
  extraBody: Record<string, unknown> = {},
): Promise<string> {
  return (await chatCompletionWithUsage(messages, maxTokens, json, extraBody)).content;
}

/** `extraBody` is merged into the request body (e.g. OpenRouter's `reasoning` options); default {} = unchanged behaviour.
 * `responseFormat`, when given, REPLACES the `json` flag's plain `{type:"json_object"}` with a real schema-
 * constrained format (e.g. `{type:"json_schema", json_schema:{name, strict:true, schema}}` -- OpenRouter's actual
 * "structured outputs" feature, not the older loose JSON mode `json` alone requests). Support is per model/
 * provider, not universal -- confirmed working for deepseek/deepseek-v4-flash (this file's CHAT_MODEL); confirmed
 * NOT supported for qwen/qwen3.5-flash-02-23 via its OpenRouter (Alibaba) endpoint, which rejects the request
 * with a 400. Check before relying on it for a different model. */
export async function chatCompletionWithUsage(
  messages: ChatMessage[],
  maxTokens = 500,
  json = false,
  extraBody: Record<string, unknown> = {},
  responseFormat?: Record<string, unknown>,
): Promise<ChatCompletionResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const started = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages,
      max_tokens: maxTokens,
      ...(responseFormat ? { response_format: responseFormat } : json ? { response_format: { type: "json_object" } } : {}),
      ...extraBody,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter chat completion failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  // OpenRouter can return HTTP 200 with the failure INSIDE the choice (finish_reason="error") when the upstream
  // provider's generation broke mid-response -- observed live on qwen3.5-flash-02-23 (its only structured-output
  // provider, Alibaba, has no failover): content came back as a garbage repeating-digit string, not `null`, so
  // the old `typeof content !== "string"` check below didn't catch it and the garbage got served as a real answer.
  if (choice?.finish_reason === "error" || choice?.error) {
    throw new Error(`OpenRouter upstream generation error: ${JSON.stringify(choice?.error ?? choice).slice(0, 500)}`);
  }
  const content = choice?.message?.content;
  if (typeof content !== "string") {
    throw new Error(
      `Unexpected OpenRouter chat response shape: finish_reason=${choice?.finish_reason} ${JSON.stringify(data).slice(0, 500)}`,
    );
  }
  const usage = (data.usage ?? {}) as ChatUsage;
  // OpenRouter reports the real charge as usage.cost (in credits = USD)
  if (typeof usage.cost_usd !== "number") {
    const cost = data.usage?.cost ?? data.cost;
    if (typeof cost === "number") usage.cost_usd = cost;
  }
  const elapsed_ms = Date.now() - started;
  recordChatTelemetry(usage, elapsed_ms);
  return { content: content.trim(), usage, elapsed_ms, provider: typeof data.provider === "string" ? data.provider : undefined };
}
