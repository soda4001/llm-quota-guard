# llm-quota-guard

Per-key token (or cost) quotas for LLM calls, built on **reserve → commit / release** holds.
In-process, zero runtime dependencies, TypeScript types included.

```ts
import { QuotaGuard, QuotaExceededError } from "llm-quota-guard";

const guard = new QuotaGuard({ limit: 200_000, windowMs: 24 * 60 * 60 * 1000 }); // per key, per day

try {
  const answer = await guard.run("tenant-42", 4_000, async () => {
    const res = await callYourProvider(/* ... */);
    return { value: res.text, actual: res.usage.totalTokens };
  });
} catch (error) {
  if (error instanceof QuotaExceededError) {
    // error.remaining, error.resetsAt, error.exceedsLimit
  } else {
    throw error;
  }
}
```

## Why holds instead of a counter

A plain `used += tokens` counter is wrong in two ways that are easy to miss:

1. **Check-then-act across an `await`.** Callers pass the limit check before any of them has added its usage.
2. **Charge-up-front without a refund.** Calls that fail before producing billable output still consume budget.

`reserve()` does the check and the hold in one synchronous step, `commit(actual)` replaces the hold with real usage, and `release()` gives the hold back. Output of `npm run example` (no network, the "LLM" is a timer):

```
limit=100, estimate=30, concurrent calls=10
1) concurrent calls
   naive counter : used=300 (limit exceeded by 200)
   QuotaGuard    : used=90, rejected=7
2) 4 calls that all fail (nothing was produced)
   naive counter : used=120
   QuotaGuard    : used=0
```

## API

| Call | Behavior |
|---|---|
| `new QuotaGuard({ limit, windowMs, holdTtlMs?, now? })` | `limit` and all amounts are **integers** (tokens, or micro-USD to avoid float drift). Windows are fixed and aligned to multiples of `windowMs` since the epoch. `holdTtlMs` defaults to 120 000. |
| `guard.reserve(key, amount)` | Holds `amount`. Throws `QuotaExceededError` if `used + held + amount > limit`. Returns a `Reservation`. |
| `reservation.commit(actual)` | Records `actual` as used and drops the hold. Usage above the estimate is recorded as `overage`, never rejected: it has already been spent. |
| `reservation.release()` | Drops the hold, records nothing. |
| `guard.run(key, estimate, fn)` | `reserve` → `fn` → `commit(actual)`; if `fn` throws, `release` and rethrow. |
| `guard.check(key)` | `{ used, held, remaining, windowStart, resetsAt, limit }`, read-only. |
| `guard.prune()` | Removes keys whose window has ended and that have no live holds. |

### Behavior worth knowing

- **Settling is idempotent.** A second `commit()` / `release()` returns the first `Settlement`; retries cannot double-count.
- **Late commits are recorded.** If a hold expired (TTL) before `commit()`, the usage is still recorded: the provider already billed it.
- **Window attribution.** Usage belongs to the window in which `reserve()` was called. A call that finishes in the next window does not charge the new window.
- **Expired holds** stop counting after `holdTtlMs`, so a crashed request cannot lock quota forever.

## Limits (read before relying on it)

- **One process, one instance.** State lives in memory and is lost on restart. It is not shared across processes, containers or serverless invocations.
- **Not a billing system.** The numbers are whatever your code reports. If a call fails *after* the provider already billed it, that usage is not recorded here.
- Keep **provider-side hard limits** as the backstop.
- Fixed windows allow a burst at a window boundary (up to `limit` at the end of one window plus `limit` at the start of the next).

## Develop

Requires Node ≥ 22.18 (runs the TypeScript sources directly).

```bash
npm install
npm test          # 22 tests, node:test
npm run typecheck
npm run example   # the demo above
npm run build     # dist/ with .js and .d.ts
```

## Status

Version 0.1.0, not yet published to npm. License: MIT.

This repository was written with AI assistance (Claude); behavior is specified by the tests in `test/`.

## Beyond this library

A larger LLM production kit is **in planning and not available yet**: shared stores, multi-rule limits, structured-output validation, regression evals and a handbook. Whether it gets built depends on demand. If it would be useful to you, the waitlist (with a short survey) is at https://soda4001.github.io/llm-production-kit/. No payment is taken there.
