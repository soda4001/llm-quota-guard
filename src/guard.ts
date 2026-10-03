import { QuotaExceededError } from "./errors.ts";

export interface QuotaGuardOptions {
  /** Maximum units per window, per key. Integer units (e.g. tokens, or micro-USD). */
  limit: number;
  /** Fixed window length in ms. Windows are aligned to multiples of this value since the epoch. */
  windowMs: number;
  /** How long an unsettled hold keeps counting before it is dropped automatically. Default 120_000. */
  holdTtlMs?: number;
  /** Clock override, mainly for tests. Default `Date.now`. */
  now?: () => number;
}

export interface QuotaStatus {
  key: string;
  limit: number;
  /** Units committed in the current window. */
  used: number;
  /** Units currently held by unsettled, unexpired reservations. */
  held: number;
  /** limit − used − held, never negative. */
  remaining: number;
  windowStart: number;
  resetsAt: number;
}

export interface Settlement {
  state: "committed" | "released";
  /** Units that were held when the reservation was made. */
  reserved: number;
  /** Units recorded as used (0 when released). */
  charged: number;
  /** max(0, charged − reserved): usage beyond the estimate. It is recorded, never rejected. */
  overage: number;
  /** The window the usage belongs to: the window in which `reserve()` was called. */
  windowStart: number;
}

interface Hold {
  amount: number;
  expiresAt: number;
}

interface KeyState {
  windowStart: number;
  used: number;
  holds: Map<string, Hold>;
}

function assertUnits(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${String(value)}`);
  }
}

/**
 * A reservation made with {@link QuotaGuard.reserve}. Settle it exactly once with
 * `commit(actual)` or `release()`. Repeated settle calls are no-ops that return the
 * original {@link Settlement}, so retries cannot double-count usage.
 */
export class Reservation {
  readonly id: string;
  readonly key: string;
  readonly amount: number;
  readonly windowStart: number;
  readonly expiresAt: number;
  readonly #settle: (outcome: { kind: "commit"; actual: number } | { kind: "release" }) => Settlement;
  #settlement: Settlement | undefined;

  constructor(
    info: { id: string; key: string; amount: number; windowStart: number; expiresAt: number },
    settle: (outcome: { kind: "commit"; actual: number } | { kind: "release" }) => Settlement,
  ) {
    this.id = info.id;
    this.key = info.key;
    this.amount = info.amount;
    this.windowStart = info.windowStart;
    this.expiresAt = info.expiresAt;
    this.#settle = settle;
  }

  get settled(): boolean {
    return this.#settlement !== undefined;
  }

  /** Record `actual` units as used and drop the hold. Late commits (after the hold expired) are still recorded. */
  commit(actual: number): Settlement {
    if (this.#settlement) return this.#settlement;
    assertUnits(actual, "actual");
    this.#settlement = this.#settle({ kind: "commit", actual });
    return this.#settlement;
  }

  /** Drop the hold without recording any usage (the call failed before the provider billed it). */
  release(): Settlement {
    if (this.#settlement) return this.#settlement;
    this.#settlement = this.#settle({ kind: "release" });
    return this.#settlement;
  }
}

/**
 * In-process quota guard with reserve → commit/release semantics.
 *
 * Scope: one process, one instance. State is not shared across processes or restarts.
 */
export class QuotaGuard {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #holdTtlMs: number;
  readonly #now: () => number;
  readonly #states = new Map<string, KeyState>();

  constructor(options: QuotaGuardOptions) {
    assertUnits(options.limit, "limit");
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs <= 0) {
      throw new RangeError("windowMs must be a positive safe integer");
    }
    const ttl = options.holdTtlMs ?? 120_000;
    if (!Number.isSafeInteger(ttl) || ttl <= 0) {
      throw new RangeError("holdTtlMs must be a positive safe integer");
    }
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#holdTtlMs = ttl;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Hold `amount` units for `key`. Throws {@link QuotaExceededError} if
   * used + held + amount would exceed the limit. The check and the hold happen in one
   * synchronous step, so concurrent callers cannot both pass the check.
   */
  reserve(key: string, amount: number): Reservation {
    this.#assertKey(key);
    assertUnits(amount, "amount");
    const now = this.#now();
    const state = this.#liveState(key, now);
    const held = this.#heldTotal(state, now);

    if (state.used + held + amount > this.#limit) {
      throw new QuotaExceededError({
        key,
        requested: amount,
        remaining: Math.max(0, this.#limit - state.used - held),
        limit: this.#limit,
        resetsAt: state.windowStart + this.#windowMs,
      });
    }

    const id = crypto.randomUUID();
    const expiresAt = now + this.#holdTtlMs;
    state.holds.set(id, { amount, expiresAt });
    const windowStart = state.windowStart;

    return new Reservation({ id, key, amount, windowStart, expiresAt }, (outcome) =>
      this.#settleReservation({ id, key, amount, windowStart }, outcome),
    );
  }

  /** Current numbers for `key` without changing anything. */
  check(key: string): QuotaStatus {
    this.#assertKey(key);
    const now = this.#now();
    const windowStart = this.#windowStartFor(now);
    const state = this.#states.get(key);
    const live = state && state.windowStart === windowStart ? state : undefined;
    const used = live?.used ?? 0;
    const held = live ? this.#heldTotal(live, now) : 0;
    return {
      key,
      limit: this.#limit,
      used,
      held,
      remaining: Math.max(0, this.#limit - used - held),
      windowStart,
      resetsAt: windowStart + this.#windowMs,
    };
  }

  /**
   * Reserve `estimate`, run `fn`, then commit the `actual` it reports. If `fn` throws,
   * the hold is released and the error is rethrown.
   *
   * Caveat: if a call fails *after* the provider already billed it, that usage is not
   * recorded here. Keep provider-side hard limits as the backstop.
   */
  async run<T>(
    key: string,
    estimate: number,
    fn: (reservation: Reservation) => Promise<{ value: T; actual: number }>,
  ): Promise<T> {
    const reservation = this.reserve(key, estimate);
    let outcome: { value: T; actual: number };
    try {
      outcome = await fn(reservation);
    } catch (error) {
      reservation.release();
      throw error;
    }
    reservation.commit(outcome.actual);
    return outcome.value;
  }

  /** Drop keys whose window has ended and that have no live holds. Returns the number removed. */
  prune(): number {
    const now = this.#now();
    const currentWindow = this.#windowStartFor(now);
    let removed = 0;
    for (const [key, state] of this.#states) {
      this.#heldTotal(state, now);
      if (state.windowStart !== currentWindow && state.holds.size === 0) {
        this.#states.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  #assertKey(key: string): void {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("key must be a non-empty string");
    }
  }

  #windowStartFor(now: number): number {
    return Math.floor(now / this.#windowMs) * this.#windowMs;
  }

  /** State for the current window; rolls the key over to a fresh window if the old one ended. */
  #liveState(key: string, now: number): KeyState {
    const windowStart = this.#windowStartFor(now);
    let state = this.#states.get(key);
    if (!state || state.windowStart !== windowStart) {
      state = { windowStart, used: 0, holds: new Map() };
      this.#states.set(key, state);
    }
    return state;
  }

  /** Sum of unexpired holds. Expired holds are deleted as a side effect. */
  #heldTotal(state: KeyState, now: number): number {
    let total = 0;
    for (const [id, hold] of state.holds) {
      if (hold.expiresAt <= now) {
        state.holds.delete(id);
      } else {
        total += hold.amount;
      }
    }
    return total;
  }

  #settleReservation(
    info: { id: string; key: string; amount: number; windowStart: number },
    outcome: { kind: "commit"; actual: number } | { kind: "release" },
  ): Settlement {
    const state = this.#states.get(info.key);
    // Usage belongs to the window the reservation was made in. If that window is gone,
    // the counters of the current window are left untouched.
    const sameWindow = state !== undefined && state.windowStart === info.windowStart;
    if (sameWindow) state.holds.delete(info.id);

    if (outcome.kind === "release") {
      return {
        state: "released",
        reserved: info.amount,
        charged: 0,
        overage: 0,
        windowStart: info.windowStart,
      };
    }

    if (sameWindow) state.used += outcome.actual;
    return {
      state: "committed",
      reserved: info.amount,
      charged: outcome.actual,
      overage: Math.max(0, outcome.actual - info.amount),
      windowStart: info.windowStart,
    };
  }
}
