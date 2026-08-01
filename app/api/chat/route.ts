// The real /api/chat endpoint -- the first Next.js Route Handler in this
// project. Wires together everything already built and tested in lib/:
// chat() (history + query rewrite + retrieve + generate + save).
// Verified working end-to-end 2026-08-01, see plan.md's MILESTONE entry.

import { randomUUID } from "crypto";
import { chat } from "@/lib/chat";
import { checkRateLimit } from "@/lib/rateLimit";

export async function POST(request: Request) {
  // Rate limit checked BEFORE reading the body -- rejects abusive callers as
  // cheaply as possible, before spending any work parsing/validating input.
  const { allowed, count, limit } = await checkRateLimit(request);
  if (!allowed) {
    // 429 Too Many Requests -- the correct status for exactly this case,
    // not used anywhere else in this project yet (400 = bad input, 500 =
    // server error; this is neither, it's "you're not wrong, just over
    // quota").
    return Response.json(
      { error: `Daily limit of ${limit} questions reached. Try again tomorrow.` },
      { status: 429 }
    );
  }
  console.log(`Rate limit: ${count}/${limit} for this IP today.`);

  const body = await request.json();
  const { question, sessionId: incomingSessionId, lawIds } = body;

  // Boundary validation -- this is real user input, not internal code, so
  // it gets checked before anything else touches it. A missing/bad question
  // fails fast with a clear 400, instead of an obscure crash deep inside
  // chat()/generateAnswer().
  if (!question || typeof question !== "string") {
    return Response.json({ error: "question is required" }, { status: 400 });
  }

  // Reuse the client's sessionId if they sent one (continuing an existing
  // conversation); otherwise mint a fresh one (this is a brand-new
  // conversation) -- decided 2026-07-27, see plan.md.
  const sessionId = incomingSessionId ?? randomUUID();

  try {
    const result = await chat(sessionId, question, lawIds);
    // Spread result's fields (answer/citations/modelUsed) into the response
    // and add sessionId alongside them, so the client can remember it and
    // send it back on the conversation's next message.
    return Response.json({ ...result, sessionId });
  } catch (e) {
    // chat() throwing here right now is the KNOWN Pinecone quota block,
    // not an unexpected bug -- but this catch handles ANY failure in the
    // pipeline the same way: log the real error server-side for debugging,
    // return a clean generic error to the client rather than leaking
    // internal details or crashing with an unhandled exception.
    console.error(e);
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }
}
