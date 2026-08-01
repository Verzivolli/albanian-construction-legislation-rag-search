// GET /api/articles/:id -- thin wrapper around lib/laws.ts's getArticleById().

import { getArticleById } from "@/lib/laws";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { id } = await params;
  try {
    const article = await getArticleById(id);
    if (!article) {
      return Response.json({ error: "Article not found." }, { status: 404 });
    }
    return Response.json({ article });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }
}
