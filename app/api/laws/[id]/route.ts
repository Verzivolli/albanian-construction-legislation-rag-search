// GET /api/laws/:id -- thin wrapper around lib/laws.ts's getLawById().

import { getLawById } from "@/lib/laws";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { id } = await params;
  try {
    const law = await getLawById(id);
    if (!law) {
      return Response.json({ error: "Law not found." }, { status: 404 });
    }
    return Response.json({ law });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }
}
