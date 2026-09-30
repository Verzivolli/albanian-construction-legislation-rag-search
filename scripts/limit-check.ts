// Self-check for lib/limit.ts: run with `npx tsx scripts/limit-check.ts`.
import assert from "node:assert/strict";
import { PER_VISITOR, cookieFor, readCookieCount, take, refund } from "../lib/limit";

const c = cookieFor(3);
assert.equal(readCookieCount(c.value), 3, "signed cookie round-trips");
assert.equal(readCookieCount(c.value.replace(/^3/, "0")), PER_VISITOR, "tampered count is treated as used up");
assert.equal(readCookieCount(undefined), 0);
for (let i = 1; i <= PER_VISITOR; i++) assert.equal(take("1.2.3.4", 0), i, "per-IP counter counts even without a cookie");
assert.equal(take("1.2.3.4", 0), null, "6th question from the same IP is refused");
refund("1.2.3.4");
assert.equal(take("1.2.3.4", 0), PER_VISITOR, "a refunded failure can be retried");
assert.equal(take("5.6.7.8", PER_VISITOR), null, "a used-up cookie is refused on a new IP");
console.log("limit checks passed");
