import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Nominatim's usage policy is an ABSOLUTE maximum of 1 request per second from
 * one application, measured at the source IP — not per user. The controller's
 * `@Throttle({ limit: 20, ttl: 60s })` is per caller, so twenty members each
 * inside their own allowance can still fire twenty simultaneous outbound
 * lookups and put the deployment's IP over the policy. The penalty is a block
 * on the IP, which fails "Locate this address" for everyone at once, so the
 * spend that has to be rationed is a process-wide one.
 *
 * This is a single-slot bucket: every acquisition reserves the next free
 * one-second slot and waits for it. Requests therefore queue rather than burst.
 * Because a queued request is holding a Node request handler open, the queue is
 * bounded twice over — by depth and by how long any one caller may be parked —
 * and an overflow fails fast with a 503 the frontend already handles by
 * falling back to a neighbourhood-centroid pin.
 *
 * Deliberately a module-level singleton rather than an injectable: "one bucket
 * per process" is the invariant, and a provider would silently become one
 * bucket per injector if the module were ever imported into a second context.
 * A keyed provider (the `housing-geo.ts` comment anticipates one) removes the
 * need for this entirely; until then this is the honest ceiling.
 */
const MIN_INTERVAL_MS = 1000;

// At one slot per second, the last request in a full queue waits ~8s. That is
// already past the point where the wizard's spinner is worth watching, so
// anything beyond it is refused immediately instead of being parked.
const MAX_QUEUE_DEPTH = 8;
const MAX_WAIT_MS = MAX_QUEUE_DEPTH * MIN_INTERVAL_MS;

/** 503 raised when the outbound geocoder queue is saturated. Carries the
 * seconds a client should wait so the controller's filter can put a real
 * `Retry-After` on the response instead of an unhelpful bare 503. */
export class GeocoderBusyException extends ServiceUnavailableException {
  constructor(readonly retryAfterSeconds: number) {
    super('The address geocoder is busy. Try again shortly, or drop a pin.');
  }
}

class NominatimRateLimiter {
  /** Epoch ms of the next slot nobody has reserved yet. */
  private nextSlotAt = 0;

  /**
   * Reserve the next outbound slot and resolve once it is due. Throws
   * `GeocoderBusyException` rather than queueing when the wait would exceed
   * `MAX_WAIT_MS`, so a burst sheds load instead of pinning handlers.
   */
  async acquire(): Promise<void> {
    const now = Date.now();
    const slotAt = Math.max(now, this.nextSlotAt);
    const waitMs = slotAt - now;
    if (waitMs > MAX_WAIT_MS) {
      throw new GeocoderBusyException(Math.ceil(waitMs / 1000));
    }
    // Reserve BEFORE awaiting: two concurrent callers must not be handed the
    // same slot, and there is no await between the read and the write.
    this.nextSlotAt = slotAt + MIN_INTERVAL_MS;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

export const nominatimRateLimiter = new NominatimRateLimiter();
