// IP-based daily rate limit for /api/chat -- replaces the auth-gated quota
// idea (no login exists, see CLAUDE.md scope reversal 2026-07-31). "Who is
// asking" is approximated by request IP instead of a user_id.

import { pool } from "./retrieve";

const DAILY_LIMIT = 50;

// Vercel's proxy sets x-forwarded-for to the real visitor's IP -- the app
// never sees the raw TCP connection directly, only what the proxy forwards.
// Locally (npm run dev) there's no proxy in front, so this header is usually
// absent -- "unknown" is the fallback, meaning every local request shares
// one bucket (fine for dev, not a real per-visitor split).
function getClientIp(request: Request): string {
  return request.headers.get("x-forwarded-for") ?? "unknown";
}

export async function checkRateLimit(
  request: Request
): Promise<{ allowed: boolean; count: number; limit: number }> {
  const ip = getClientIp(request);

  // Atomic upsert: insert a fresh row at count=1, or -- if a row for this
  // exact (ip, today) pair already exists -- bump its count instead. One
  // indivisible statement, so two near-simultaneous requests from the same
  // IP can't both read the same starting count and silently lose an
  // increment (the classic read-then-write race). `returning count` hands
  // back the new value in the same round trip, no second query needed.
  const result = await pool.query<{ count: number }>(
    `insert into rate_limits (ip, request_date, count)
     values ($1, current_date, 1)
     on conflict (ip, request_date)
     do update set count = rate_limits.count + 1
     returning count`,
    [ip]
  );

  const count = result.rows[0].count;
  return { allowed: count <= DAILY_LIMIT, count, limit: DAILY_LIMIT };
}
