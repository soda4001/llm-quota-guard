import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QuotaExceededError, QuotaGuard } from "../src/index.ts";

const WINDOW = 60_000;

/** A guard with a manually advanced clock. */
function makeGuard(options: { limit?: number; holdTtlMs?: number } = {}) {
  const clock = { now: 10 * WINDOW + 5_000 }; // 5s into a window
  const guard = new QuotaGuard({
    limit: options.limit ?? 100,
    windowMs: WINDOW,
    holdTtlMs: options.holdTtlMs,
    now: () => clock.now,
  });
  return { guard, clock };
}

describe("reserve", () => {
  it("admits requests that fit and counts holds against the limit", () => {
    const { guard } = makeGuard({ limit: 100 });
    guard.reserve("a", 60);
    assert.equal(guard.check("a").held, 60);
    assert.equal(guard.check("a").remaining, 40);
    assert.throws(() => guard.reserve("a", 41), QuotaExceededError);
    assert.doesNotThrow(() => guard.reserve("a", 40));
    assert.equal(guard.check("a").remaining, 0);
  });

  it("admits exactly floor(limit / amount) back-to-back reservations", () => {
    const { guard } = makeGuard({ limit: 100 });
    let admitted = 0;
    for (let i = 0; i < 10; i += 1) {
      try {
        guard.reserve("a", 30);
        admitted += 1;
      } catch (error) {
        assert.ok(error instanceof QuotaExceededError);
      }
    }
    assert.equal(admitted, 3);
  });

  it("keeps keys independent", () => {
    const { guard } = makeGuard({ limit: 50 });
    guard.reserve("a", 50);
    assert.doesNotThrow(() => guard.reserve("b", 50));
  });

  it("reports details on QuotaExceededError", () => {
    const { guard, clock } = makeGuard({ limit: 100 });
    guard.reserve("a", 70);
    try {
      guard.reserve("a", 50);
      assert.fail("expected QuotaExceededError");
    } catch (error) {
      assert.ok(error instanceof QuotaExceededError);
      assert.equal(error.key, "a");
      assert.equal(error.requested, 50);
      assert.equal(error.remaining, 30);
      assert.equal(error.limit, 100);
      assert.equal(error.exceedsLimit, false);
      assert.equal(error.resetsAt, Math.floor(clock.now / WINDOW) * WINDOW + WINDOW);
    }
  });

  it("flags requests larger than the limit as never satisfiable", () => {
    const { guard } = makeGuard({ limit: 100 });
    try {
      guard.reserve("a", 101);
      assert.fail("expected QuotaExceededError");
    } catch (error) {
      assert.ok(error instanceof QuotaExceededError);
      assert.equal(error.exceedsLimit, true);
    }
  });

  it("rejects invalid input", () => {
    const { guard } = makeGuard();
    assert.throws(() => guard.reserve("", 1), TypeError);
    assert.throws(() => guard.reserve("a", -1), RangeError);
    assert.throws(() => guard.reserve("a", 1.5), RangeError);
    assert.throws(() => guard.reserve("a", Number.NaN), RangeError);
    assert.throws(() => new QuotaGuard({ limit: -1, windowMs: WINDOW }), RangeError);
    assert.throws(() => new QuotaGuard({ limit: 1, windowMs: 0 }), RangeError);
    assert.throws(() => new QuotaGuard({ limit: 1, windowMs: WINDOW, holdTtlMs: 0 }), RangeError);
  });
});

describe("commit / release", () => {
  it("replaces the hold with actual usage", () => {
    const { guard } = makeGuard({ limit: 100 });
    const r = guard.reserve("a", 60);
    const settlement = r.commit(25);
    assert.deepEqual(
      { state: settlement.state, reserved: settlement.reserved, charged: settlement.charged, overage: settlement.overage },
      { state: "committed", reserved: 60, charged: 25, overage: 0 },
    );
    const status = guard.check("a");
    assert.equal(status.used, 25);
    assert.equal(status.held, 0);
    assert.equal(status.remaining, 75);
  });

  it("records usage above the estimate as overage instead of rejecting it", () => {
    const { guard } = makeGuard({ limit: 100 });
    const r = guard.reserve("a", 40);
    const settlement = r.commit(70);
    assert.equal(settlement.overage, 30);
    assert.equal(guard.check("a").used, 70);
    assert.equal(guard.check("a").remaining, 30);
  });

  it("release frees the hold and records nothing", () => {
    const { guard } = makeGuard({ limit: 100 });
    const r = guard.reserve("a", 80);
    const settlement = r.release();
    assert.equal(settlement.state, "released");
    assert.equal(settlement.charged, 0);
    assert.deepEqual(
      { used: guard.check("a").used, held: guard.check("a").held },
      { used: 0, held: 0 },
    );
  });

  it("is idempotent: settling twice never double-counts", () => {
    const { guard } = makeGuard({ limit: 100 });
    const r = guard.reserve("a", 50);
    const first = r.commit(30);
    const second = r.commit(30);
    const third = r.commit(99); // a retry with different numbers is ignored
    assert.strictEqual(second, first);
    assert.strictEqual(third, first);
    assert.equal(guard.check("a").used, 30);
  });

  it("ignores release after commit and commit after release", () => {
    const { guard } = makeGuard({ limit: 100 });
    const a = guard.reserve("a", 50);
    a.commit(20);
    assert.equal(a.release().state, "committed");
    assert.equal(guard.check("a").used, 20);

    const b = guard.reserve("b", 50);
    b.release();
    assert.equal(b.commit(20).state, "released");
    assert.equal(guard.check("b").used, 0);
  });

  it("rejects invalid actual without settling", () => {
    const { guard } = makeGuard({ limit: 100 });
    const r = guard.reserve("a", 50);
    assert.throws(() => r.commit(-5), RangeError);
    assert.equal(r.settled, false);
    assert.equal(guard.check("a").held, 50);
  });
});

describe("hold expiry", () => {
  it("drops an unsettled hold after the TTL", () => {
    const { guard, clock } = makeGuard({ limit: 100, holdTtlMs: 1_000 });
    guard.reserve("a", 100);
    assert.throws(() => guard.reserve("a", 1), QuotaExceededError);
    clock.now += 1_000;
    assert.equal(guard.check("a").held, 0);
    assert.doesNotThrow(() => guard.reserve("a", 100));
  });

  it("still records a late commit: the provider already billed it", () => {
    const { guard, clock } = makeGuard({ limit: 100, holdTtlMs: 1_000 });
    const r = guard.reserve("a", 60);
    clock.now += 5_000; // hold expired, same window
    assert.equal(guard.check("a").held, 0);
    r.commit(60);
    assert.equal(guard.check("a").used, 60);
  });
});

describe("windows", () => {
  it("resets usage when the window rolls over", () => {
    const { guard, clock } = makeGuard({ limit: 100 });
    guard.reserve("a", 100).commit(100);
    assert.throws(() => guard.reserve("a", 1), QuotaExceededError);
    clock.now += WINDOW;
    assert.equal(guard.check("a").used, 0);
    assert.doesNotThrow(() => guard.reserve("a", 100));
  });

  it("attributes a commit to the window of its reservation", () => {
    const { guard, clock } = makeGuard({ limit: 100 });
    const r = guard.reserve("a", 50);
    const reservedIn = r.windowStart;
    clock.now += WINDOW; // call finishes in the next window
    const settlement = r.commit(50);
    assert.equal(settlement.windowStart, reservedIn);
    assert.equal(guard.check("a").used, 0, "the new window must not be charged");
    assert.equal(guard.check("a").held, 0, "the old hold must not carry over");
  });

  it("prune removes only ended windows without live holds", () => {
    const { guard, clock } = makeGuard({ limit: 100 });
    guard.reserve("done", 10).commit(10);
    const pending = guard.reserve("pending", 10);
    clock.now += WINDOW;
    assert.equal(guard.prune(), 1); // "done" goes; "pending" is in an ended window but still held
    assert.equal(guard.prune(), 0);
    pending.release();
    assert.equal(guard.prune(), 1);
  });
});

describe("run", () => {
  it("commits the reported actual and returns the value", async () => {
    const { guard } = makeGuard({ limit: 100 });
    const value = await guard.run("a", 50, async () => ({ value: "ok", actual: 12 }));
    assert.equal(value, "ok");
    assert.equal(guard.check("a").used, 12);
    assert.equal(guard.check("a").held, 0);
  });

  it("releases the hold and rethrows when fn throws", async () => {
    const { guard } = makeGuard({ limit: 100 });
    const boom = new Error("provider 500");
    await assert.rejects(
      guard.run("a", 50, async () => {
        throw boom;
      }),
      (error: unknown) => error === boom,
    );
    assert.deepEqual(
      { used: guard.check("a").used, held: guard.check("a").held },
      { used: 0, held: 0 },
    );
  });

  it("rejects before calling fn when the quota is exhausted", async () => {
    const { guard } = makeGuard({ limit: 10 });
    let called = false;
    await assert.rejects(
      guard.run("a", 11, async () => {
        called = true;
        return { value: 1, actual: 1 };
      }),
      QuotaExceededError,
    );
    assert.equal(called, false);
  });

  it("admits at most floor(limit / estimate) concurrent calls", async () => {
    const { guard } = makeGuard({ limit: 100 });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        guard.run("a", 30, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { value: true, actual: 30 };
        }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
    assert.equal(guard.check("a").used, 90);
  });

  it("leaves the hold to expire when fn reports an invalid actual", async () => {
    const { guard, clock } = makeGuard({ limit: 100, holdTtlMs: 1_000 });
    await assert.rejects(
      guard.run("a", 50, async () => ({ value: 1, actual: Number.NaN })),
      RangeError,
    );
    assert.equal(guard.check("a").held, 50);
    clock.now += 1_000;
    assert.equal(guard.check("a").held, 0);
  });
});
