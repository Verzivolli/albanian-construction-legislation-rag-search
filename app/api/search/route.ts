// GET /api/search?q=... -- thin wrapper around lib/laws.ts's
// searchArticles(). See that function for the ILIKE-vs-tsvector decision.

import { searchArticles } from "@/lib/laws";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q");

  if (!q || q.trim().length === 0) {
    return Response.json({ error: "q query parameter is required" }, { status: 400 });
  }

  try {
    const results = await searchArticles(q);
    return Response.json({ results });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }
}
