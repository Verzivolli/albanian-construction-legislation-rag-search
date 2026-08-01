// GET /api/chat/:sessionId    -- full message history for one conversation.
// DELETE /api/chat/:sessionId -- delete every message in that conversation.
//
// Dynamic route: the [sessionId] folder name captures whatever's in that
// URL position and hands it to each handler via the second argument.
// KNOWN GAP (see plan.md): no ownership check -- chat_messages has no
// user_id/RLS yet, so this only relies on session ids being unguessable
// random UUIDs, not real per-user access control. Fine for current MVP
// scope, not fine once real auth is wired in.

import { getHistory, deleteSession } from "@/lib/chat";

// In this Next.js version, dynamic route params arrive as a Promise, not a
// plain object -- confirmed against Next's own bundled docs before writing
// this, not assumed from general Next.js knowledge (see plan.md).
type RouteParams = { params: Promise<{ sessionId: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { sessionId } = await params;
  const messages = await getHistory(sessionId);
  return Response.json({ sessionId, messages });
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const { sessionId } = await params;
  await deleteSession(sessionId);
  return Response.json({ sessionId, deleted: true });
}
