// 5 live questions per visitor, without an external store.
// Layer 1: a signed cookie counts questions per visitor per day (tampering breaks the signature).
// Layer 2: an in-memory per-IP counter per server instance (catches cookie clearing on a warm instance).
// Layer 3: a per-instance daily cap on all live questions.
// ponytail: no shared store, so limits are per instance; the hard cost ceiling is the OpenRouter key's own credit limit.
import { createHmac, timingSafeEqual } from "node:crypto";

export const PER_VISITOR = 5;
const PER_INSTANCE_DAILY = 150;
const COOKIE = "ktp_q";

const secret = () => process.env.DEMO_SECRET ?? process.env.OPENROUTER_API_KEY ?? "local-dev";
const today = () => new Date().toISOString().slice(0, 10);
const sign = (v: string) => createHmac("sha256", secret()).update(v).digest("base64url").slice(0, 22);

export function readCookieCount(cookieValue: string | undefined): number {
  if (!cookieValue) return 0;
  const [count, day, sig] = cookieValue.split(".");
  if (day !== today() || !sig) return 0;
  const expected = sign(`${count}.${day}`);
  const ok = sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  return ok ? Math.max(0, Number(count) || 0) : PER_VISITOR; // tampered cookie: treat as used up
}

export function cookieFor(count: number): { name: string; value: string; maxAge: number } {
  const v = `${count}.${today()}`;
  return { name: COOKIE, value: `${v}.${sign(v)}`, maxAge: 60 * 60 * 24 };
}
export const COOKIE_NAME = COOKIE;

const byIp = new Map<string, { day: string; count: number }>();
let instance = { day: today(), count: 0 };

/** Returns the visitor's used count after this question, or null if a limit is reached. */
export function take(ip: string, cookieCount: number): number | null {
  const day = today();
  if (instance.day !== day) instance = { day, count: 0 };
  const ipEntry = byIp.get(ip);
  const ipCount = ipEntry?.day === day ? ipEntry.count : 0;
  const used = Math.max(cookieCount, ipCount);
  if (used >= PER_VISITOR || instance.count >= PER_INSTANCE_DAILY) return null;
  byIp.set(ip, { day, count: used + 1 });
  instance.count++;
  return used + 1;
}

/** Give a question back when the pipeline failed, so errors don't eat the visitor's quota. */
export function refund(ip: string) {
  const e = byIp.get(ip);
  if (e && e.count > 0) e.count--;
  if (instance.count > 0) instance.count--;
}
