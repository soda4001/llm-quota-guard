/**
 * Reproduces two failure modes of a "check, call, then add" counter and shows the
 * same workload through QuotaGuard. No network, no API keys: the "LLM" is a timer.
 *
 *   npm run example
 */
import { QuotaExceededError, QuotaGuard } from "../src/index.ts";

const LIMIT = 100; // units per window (think: tokens)
const ESTIMATE = 30; // what we expect one call to cost
const CALLS = 10; // concurrent callers

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stand-in for a provider call. Bills `cost` units, optionally fails after billing. */
async function fakeLlm(cost: number, failAfterwards = false): Promise<number> {
  await sleep(5);
  if (failAfterwards) throw new Error("provider returned 500");
  return cost;
}

// --- Failure mode 1: check-then-act across an await -------------------------------
async function naiveConcurrent(): Promise<number> {
  let used = 0;
  async function call(): Promise<void> {
    if (used + ESTIMATE > LIMIT) return; // check
    const actual = await fakeLlm(ESTIMATE); // ...other callers pass the same check meanwhile
    used += actual; // act
  }
  await Promise.all(Array.from({ length: CALLS }, call));
  return used;
}

async function guardedConcurrent(): Promise<{ used: number; rejected: number }> {
  const guard = new QuotaGuard({ limit: LIMIT, windowMs: 60_000 });
  let rejected = 0;
  await Promise.all(
    Array.from({ length: CALLS }, () =>
      guard
        .run("tenant-1", ESTIMATE, async () => ({ value: null, actual: await fakeLlm(ESTIMATE) }))
        .catch((error: unknown) => {
          if (error instanceof QuotaExceededError) rejected += 1;
          else throw error;
        }),
    ),
  );
  return { used: guard.check("tenant-1").used, rejected };
}

// --- Failure mode 2: charging up front and never refunding failures ----------------
async function naiveLeak(): Promise<number> {
  let used = 0;
  for (let i = 0; i < 4; i += 1) {
    used += ESTIMATE; // charge before the call
    try {
      await fakeLlm(ESTIMATE, true); // every call fails before producing billable output
    } catch {
      // nobody gives the estimate back
    }
  }
  return used;
}

async function guardedNoLeak(): Promise<number> {
  const guard = new QuotaGuard({ limit: LIMIT, windowMs: 60_000 });
  for (let i = 0; i < 4; i += 1) {
    await guard
      .run("tenant-1", ESTIMATE, async () => ({ value: null, actual: await fakeLlm(ESTIMATE, true) }))
      .catch(() => undefined);
  }
  return guard.check("tenant-1").used;
}

const naive = await naiveConcurrent();
const guarded = await guardedConcurrent();
console.log(`limit=${LIMIT}, estimate=${ESTIMATE}, concurrent calls=${CALLS}`);
console.log(`1) concurrent calls`);
console.log(`   naive counter : used=${naive} (limit exceeded by ${naive - LIMIT})`);
console.log(`   QuotaGuard    : used=${guarded.used}, rejected=${guarded.rejected}`);
console.log(`2) 4 calls that all fail (nothing was produced)`);
console.log(`   naive counter : used=${await naiveLeak()}`);
console.log(`   QuotaGuard    : used=${await guardedNoLeak()}`);
