import { NextRequest } from "next/server";
import { JEV_STEPS, JEV_PARAMS, initialCtx, runPipeline, flowResult } from "@/utils/kb/ktp-steps";
import { getReference } from "@/utils/kb/catalog";
import { COOKIE_NAME, PER_VISITOR, cookieFor, readCookieCount, refund, take } from "@/lib/limit";

export const runtime = "nodejs";
export const maxDuration = 60;

const TIMEOUT_MS = 50_000; // same cut-off as KodiAI's /api/search/ktp

type Turn = { question: string; answer: string };

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { query?: unknown; history?: unknown } | null;
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query) return Response.json({ error: "Missing question." }, { status: 400 });
  if (query.length > 300) return Response.json({ error: "Please keep the question under 300 characters." }, { status: 400 });
  const history: Turn[] = (Array.isArray(body?.history) ? body.history : [])
    .filter((t): t is Turn => typeof t?.question === "string" && typeof t?.answer === "string")
    .slice(-3)
    .map((t) => ({ question: t.question.slice(0, 300), answer: t.answer.slice(0, 2000) }));

  const ip = (request.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  const used = take(ip, readCookieCount(request.cookies.get(COOKIE_NAME)?.value));
  if (used === null) {
    return Response.json({ error: "limit", remaining: 0 }, { status: 429 });
  }

  try {
    const ctx = await Promise.race([
      runPipeline(JEV_STEPS, initialCtx({ query, history, documentIds: [] }, JEV_PARAMS)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
    ]);
    const result = flowResult(ctx);
    if (!result.answer.trim()) throw new Error("empty answer");
    const references = Object.fromEntries(
      await Promise.all(result.citations.map(async (c) => [c.id, await getReference("ktp", c.id)] as const)),
    );
    const res = Response.json({ answer: result.answer, citations: result.citations, references, remaining: PER_VISITOR - used });
    const c = cookieFor(used);
    res.headers.append("Set-Cookie", `${c.name}=${c.value}; Max-Age=${c.maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`);
    return res;
  } catch (e) {
    refund(ip);
    const timedOut = e instanceof Error && e.message === "timeout";
    console.error("[ktp demo]", e);
    return Response.json(
      { error: timedOut ? "The search took too long. Please try again." : "The search failed. Please try again.", remaining: PER_VISITOR - used + 1 },
      { status: timedOut ? 504 : 500 },
    );
  }
}

/** Remaining live questions for this visitor (from the signed cookie). */
export async function GET(request: NextRequest) {
  return Response.json({ remaining: Math.max(0, PER_VISITOR - readCookieCount(request.cookies.get(COOKIE_NAME)?.value)) });
}
