// Browsable law library -- list view. Thin wrapper around lib/laws.ts's
// getLaws(), so app/laws/page.tsx (Server Component) can call the exact
// same function directly instead of fetching this route over HTTP (see
// plan.md's Decision 1, 2026-08-01).

import { getLaws } from "@/lib/laws";

export async function GET() {
  try {
    const laws = await getLaws();
    return Response.json({ laws });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "Something went wrong." }, { status: 500 });
  }
}
