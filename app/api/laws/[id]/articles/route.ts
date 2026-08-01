// GET /api/laws/:id/articles -- thin wrapper around lib/laws.ts's
// getArticlesByLawId(). See that function for the ordering caveat
// (no explicit position column, relies on created_at matching ingestion
// order) and the null-vs-empty-array distinction (law not found vs law
// exists with zero articles).

import { getArticlesByLawId } from "@/lib/laws";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { id } = await params;
  try {
    const articles = await getArticlesByLawId(id);
    if (articles === null) {
      return Response.json({ error: "Law not found." }, { status: 404 });
    }
    return Response.json({ articles });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }
}
