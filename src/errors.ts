/** Thrown by `reserve()` / `run()` when the requested units do not fit in the current window. */
export class QuotaExceededError extends Error {
  readonly key: string;
  readonly requested: number;
  /** Units still available right now (limit − used − held), never negative. */
  readonly remaining: number;
  readonly limit: number;
  /** Epoch ms at which the current window ends and `used` resets. */
  readonly resetsAt: number;
  /** True when `requested > limit`: the request can never succeed, in any window. */
  readonly exceedsLimit: boolean;

  constructor(details: {
    key: string;
    requested: number;
    remaining: number;
    limit: number;
    resetsAt: number;
  }) {
    super(
      `Quota exceeded for "${details.key}": requested ${details.requested}, ` +
        `remaining ${details.remaining} of ${details.limit}.`,
    );
    this.name = "QuotaExceededError";
    this.key = details.key;
    this.requested = details.requested;
    this.remaining = details.remaining;
    this.limit = details.limit;
    this.resetsAt = details.resetsAt;
    this.exceedsLimit = details.requested > details.limit;
  }
}
