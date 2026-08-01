// Shared LLM-calling logic with automatic fallback -- TypeScript port of
// python-etl/llm_client.py. Both the legislation chat flow and the future
// Eurocodes chat flow will import this instead of each duplicating the
// provider list.
//
// All three providers speak the same OpenAI-compatible chat completions
// format, so one client class covers all of them -- just a different
// baseURL/key/model per provider (same reasoning as the Python version).

import OpenAI from "openai";

// TypeScript interface: every object claiming to be a "Provider" MUST have
// exactly these 4 fields, each of this exact type. Catches a typo'd field
// name or a missing one at compile time, before the code ever runs --
// Python's plain dicts (used in the original) don't check this at all.
interface Provider {
  name: string;
  baseURL: string;
  apiKeyEnv: string;
  model: string;
}

const LLM_PROVIDERS: Provider[] = [
  {
    name: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnv: "GOOGLE_API_KEY",
    model: "gemini-flash-latest",
  },
  {
    name: "groq",
    baseURL: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    model: "llama-3.1-8b-instant",
  },
  {
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    model: "openai/gpt-oss-20b:free",
  },
];

// A minimal chat message shape -- just role + content, matching what every
// provider's chat completions endpoint expects.
// Exported so chat.ts can type conversation history against this same
// shape, instead of redefining an identical interface there.
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Return shape callers get back: the model's text answer, plus which
// provider actually answered (useful for the "[answered by gemini]"-style
// debug output the Python version printed).
interface LLMResult {
  content: string;
  modelUsed: string;
}

/**
 * Call the LLM provider chain with automatic fallback -- first success
 * wins. `async` because every provider call is a network request; Node
 * doesn't block the whole server while waiting, unlike a plain Python
 * script running one call at a time with nothing else to do meanwhile.
 */
export async function callLLM(messages: ChatMessage[]): Promise<LLMResult> {
  for (const provider of LLM_PROVIDERS) {
    try {
      // Same OpenAI client class works for all 3 providers -- only the
      // baseURL/key/model differ, exactly like the Python version.
      const client = new OpenAI({
        baseURL: provider.baseURL,
        apiKey: process.env[provider.apiKeyEnv],
      });
      const response = await client.chat.completions.create({
        model: provider.model,
        messages,
      });
      return {
        content: response.choices[0].message.content ?? "",
        modelUsed: provider.name,
      };
    } catch (e) {
      // Log and move on to the next provider -- same fallback behavior as
      // the Python version's try/except loop.
      console.log(`  ${provider.name} failed: ${e}`);
    }
  }
  throw new Error("All LLM providers failed.");
}
