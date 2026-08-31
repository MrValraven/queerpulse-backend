import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Agent as HttpsAgent } from 'node:https';
import { In, Repository } from 'typeorm';
import webPush from 'web-push';
import { runWithConcurrency } from '../common/run-with-concurrency';
import {
  assertPublicUrl,
  pinnedHttpsAgent,
  type ValidatedTarget,
} from '../link-preview/ssrf';
import { PushSubscription } from './entities/push-subscription.entity';

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  // `url` is the click-through path (the service worker opens it); every push
  // carries one. `conversationId` is DM-specific and optional — event reminders
  // and other non-DM pushes omit it.
  data: { url: string; conversationId?: string };
  // Optional presentation fields — the service worker validates each; iOS ignores
  // icon/image/actions/vibrate/requireInteraction/silent and shows title + body.
  // Field names MUST match the frontend `DirectMessagePush` validator exactly.
  icon?: string;
  image?: string;
  actions?: { action: string; title: string }[];
  renotify?: boolean;
  vibrate?: number[];
  requireInteraction?: boolean;
  silent?: boolean;
  // Optional localization hint. The backend stays language-neutral — `title`/
  // `body` above are always the English fallback a sender must still set. The
  // service worker resolves `titleKey`/`bodyKey` against its bundled EN/PT
  // catalog (queerpulse/src/pushMessages.ts) in the recipient's language,
  // interpolating `params`, and falls back to plain title/body otherwise
  // (also what iOS renders, since it never runs the SW's push-handler JS).
  // Field shape MUST match the frontend `DirectMessagePush.l10n` exactly
  // (lockstep contract) or the SW validator drops it silently.
  l10n?: {
    titleKey?: string;
    bodyKey?: string;
    params?: Record<string, string>;
  };
  // Optional epoch-ms event time (message `createdAt` / event start /
  // notification `createdAt`) — NOT delivery time. The service worker passes
  // this to `showNotification` so a queued/delayed push still shows the true
  // moment the underlying event happened. Field shape MUST match the frontend
  // `DirectMessagePush.timestamp` exactly (lockstep contract).
  timestamp?: number;
}

interface WebPushError {
  statusCode?: number;
}

// A hung push endpoint must not leave an unresolved promise accumulating off the
// request path — abandon the send after this long (the underlying request may
// still be in flight, which is fine for fire-and-forget delivery).
const PUSH_SEND_TIMEOUT_MS = 10_000;

// One reminder or event-update broadcast resolves every recipient's devices in
// a single query, and each row then costs an outbound HTTPS POST plus a
// `last_used_at` write. Handing all of those to one `Promise.all` starts them in
// the same tick, so a popular gathering opens hundreds of concurrent sockets and
// queues hundreds of writes against a `DATABASE_POOL_MAX` that defaults to 10 on
// a single-replica backend: unrelated requests then sit behind the fan-out and
// can burn the whole 10s `DATABASE_CONNECTION_TIMEOUT_MS` waiting for a pool
// slot. Waves of at most this many sends keep both the socket count and the
// write concurrency bounded.
//
// Deliberately wider than search's 5 concurrent queries, because the two
// fan-outs are bound by different things: a search thunk holds a pool
// connection for its whole life, while a push holds a socket for up to
// `PUSH_SEND_TIMEOUT_MS` and only touches the pool for a short write afterwards.
//
// What this bound actually gives, stated precisely: one fan-out never holds
// more than 8 of the 10 pool slots at once, so it leaves headroom for
// concurrent request traffic instead of queueing hundreds of writes ahead of
// it. It is not a guarantee that a live request always finds a free slot, and
// it is per-call, so `PushPreviewPrivacyService` sends its two payload variants
// one after the other rather than concurrently to keep the real ceiling at 8.
const MAX_CONCURRENT_PUSH_SENDS = 8;

@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private enabled = false;

  constructor(
    @InjectRepository(PushSubscription)
    private readonly subscriptions: Repository<PushSubscription>,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const publicKey = this.config.get<string>('push.vapidPublicKey');
    const privateKey = this.config.get<string>('push.vapidPrivateKey');
    const subject = this.config.get<string>('push.vapidSubject');
    if (publicKey && privateKey && subject) {
      webPush.setVapidDetails(subject, publicKey, privateKey);
      this.enabled = true;
    } else {
      this.logger.warn('Web Push disabled: VAPID keys not configured');
    }
  }

  async saveSubscription(
    userId: string,
    input: { endpoint: string; keys: { p256dh: string; auth: string } },
    userAgent?: string,
  ): Promise<void> {
    // Endpoints are unique per row on purpose: a browser hands back the SAME
    // push subscription (endpoint + keys) after its user logs out and another
    // logs in, so one physical device must map to exactly one owner — splitting
    // by (userId, endpoint) would leave two rows sharing keys and deliver one
    // member's notifications to whoever now uses that browser. Re-subscribing
    // the same device (or a device that moved to another account) therefore
    // updates the row in place.
    //
    // The flip side is that overwriting `userId` transfers the endpoint away
    // from its current owner. A legitimate account switch is indistinguishable
    // from a forged subscription that reuses a victim's endpoint (a DoS that
    // requires already knowing that secret endpoint), so we cannot block the
    // transfer without breaking shared devices — but we log every cross-account
    // reassignment so the otherwise-silent takeover is at least auditable.
    const existing = await this.subscriptions.findOne({
      where: { endpoint: input.endpoint },
      select: ['userId'],
    });
    if (existing && existing.userId !== userId) {
      this.logger.warn(
        `Push endpoint reassigned from user ${existing.userId} to ${userId}`,
      );
    }
    // A (re)subscribe is the device telling us it is alive, so it refreshes
    // `last_used_at` the same way a successful delivery does. Without this the
    // only thing that ever moved that column was a successful send, and the
    // 90-day retention purge deletes on `COALESCE(last_used_at, created_at)`:
    // a device that stays online (the DM push listener skips online recipients
    // entirely) or simply gets no qualifying notifications was unsubscribed
    // server-side while the browser still believed it was subscribed, and the
    // first push that mattered went nowhere.
    await this.subscriptions.upsert(
      {
        userId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: userAgent ?? null,
        lastUsedAt: new Date(),
      },
      ['endpoint'],
    );
  }

  async removeSubscription(userId: string, endpoint: string): Promise<void> {
    await this.subscriptions.delete({ userId, endpoint });
  }

  // Backs `GET /push/subscriptions` — lets a member see every device currently
  // registered to receive their pushes (IDN-7: a lost/stolen device otherwise
  // has no remote "stop sending this device pushes" control). Newest first, to
  // match the sessions list's ordering convention.
  async listSubscriptions(userId: string): Promise<PushSubscription[]> {
    return this.subscriptions.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  // Backs `DELETE /push/subscriptions/:id`. Ownership is verified by userId,
  // not just the row id, so one member can never revoke another member's
  // device (IDOR) — mirrors `AccountService.revokeSession`.
  async removeSubscriptionById(
    userId: string,
    subscriptionId: string,
  ): Promise<void> {
    const row = await this.subscriptions.findOne({
      where: { id: subscriptionId, userId },
    });
    if (!row) {
      throw new NotFoundException('Push subscription not found');
    }
    await this.subscriptions.delete(row.id);
  }

  // Single-recipient convenience wrapper — delegates to `sendToUsers` so every
  // caller (single or fan-out) shares the one-query subscription lookup below.
  async sendToUser(userId: string, payload: PushPayload): Promise<void> {
    return this.sendToUsers([userId], payload);
  }

  // Fan out one push payload to every recipient's subscriptions in ONE query
  // instead of one `find` per recipient. Callers that used to loop
  // `userIds.map((userId) => this.push.sendToUser(userId, payload))`
  // (`push.listener.ts`'s group/DM message fan-out, `event-reminders.service.ts`'s
  // reminder fan-out) turned N recipients into N subscription lookups; this
  // resolves every recipient's subscriptions with a single `IN (...)` query.
  async sendToUsers(userIds: string[], payload: PushPayload): Promise<void> {
    if (!this.enabled || userIds.length === 0) return;
    const rows = await this.subscriptions.find({
      where: { userId: In(userIds) },
      // Only what `deliverToSubscription` reads. A broadcast to a popular
      // gathering materializes every recipient's every device before the cap
      // does anything, and `userAgent` is an unbounded string that nothing on
      // this path looks at.
      select: ['id', 'endpoint', 'p256dh', 'auth'],
    });
    const body = JSON.stringify(payload);
    // Each entry is a THUNK (not a started promise) so `runWithConcurrency`
    // decides when a send actually starts; mapping to started promises here
    // would open every socket in the same tick and defeat the cap entirely.
    // `deliverToSubscription` is structurally incapable of rejecting, which
    // matters: a rejection would take one of the pool's workers out of service
    // for the rest of this fan-out.
    // The trailing `catch` makes the thunk total no matter what
    // `deliverToSubscription` does, including its own last-resort logger call
    // throwing. Without it "can never reject" would be a claim about that
    // method's body that the next editor has to keep true by hand, and a
    // rejection takes one of the pool's workers out of service for the rest of
    // this fan-out.
    const sendThunks = rows.map(
      (row) => (): Promise<void> =>
        this.deliverToSubscription(row, body).catch(() => undefined),
    );
    await runWithConcurrency(sendThunks, MAX_CONCURRENT_PUSH_SENDS);
  }

  // One subscription's delivery. Wrapped end to end because every failure mode
  // here is per-device and must not affect the other recipients in the fan-out.
  // The outer catch is what makes the awaits inside the inner catch (the prune)
  // and any future log or write added there safe. It is belt to the caller's
  // braces: the only statement it cannot itself cover is its own logger call,
  // which is why the thunk in `sendToUsers` catches as well.
  private async deliverToSubscription(
    row: PushSubscription,
    body: string,
  ): Promise<void> {
    try {
      // SSRF guard: the endpoint is member-supplied and we are about to POST
      // to it. Re-validate at send time (DNS resolution can differ from the
      // subscribe-time DTO check) that it resolves to a public host. On
      // rejection, skip this subscription and keep delivering to the others.
      // Do NOT prune the row, since a transient DNS failure here would
      // otherwise drop a legitimate device.
      let validated: ValidatedTarget;
      try {
        validated = await assertPublicUrl(row.endpoint);
      } catch (error) {
        this.logger.warn(
          `Skipping push to non-public endpoint for ${row.id}: ${String(error)}`,
        );
        return;
      }

      let hasDelivered = false;
      try {
        // Pin the send to the exact IP we just validated: web-push uses Node's
        // `https`, which would otherwise re-resolve the endpoint host at
        // connect time and could be rebound to an internal address between the
        // check above and the socket. The pinned Agent fixes the dialled IP
        // while keeping the original host for TLS SNI / cert validation.
        await this.sendWithTimeout(
          {
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth },
          },
          body,
          pinnedHttpsAgent(validated),
        );
        hasDelivered = true;
        // Left as one write per delivered device rather than a batched
        // `UPDATE ... WHERE id IN (...)`: `last_used_at` is what the 90-day
        // retention purge reads, so a device we just delivered to has to have
        // it recorded even if the process dies mid fan-out, and a batched write
        // would also have to defer the 404/410 prune below to the same flush.
        // The concurrency cap already bounds these to
        // `MAX_CONCURRENT_PUSH_SENDS` in flight, which is the pool pressure
        // that mattered; what is left is a per-row round trip against a
        // primary key.
        await this.subscriptions.update(row.id, { lastUsedAt: new Date() });
      } catch (error) {
        // Optional chaining, not a bare cast: the cast is erased at runtime, so
        // a rejection value that is null or undefined would make a plain
        // property read throw from inside this catch.
        const statusCode = (error as WebPushError | null)?.statusCode;
        if (hasDelivered) {
          // The push itself landed, only the `last_used_at` bump failed. Saying
          // "send failed" here would send someone hunting the wrong system.
          this.logger.warn(
            `Delivered push but failed to record last_used_at for ${row.id}: ${String(error)}`,
          );
        } else if (statusCode === 404 || statusCode === 410) {
          await this.subscriptions.delete(row.id);
        } else {
          this.logger.warn(
            `Web Push send failed for ${row.id}: ${statusCode ?? String(error)}`,
          );
        }
      }
    } catch (unexpectedError) {
      this.logger.warn(
        `Unexpected push delivery failure for ${row.id}: ${String(unexpectedError)}`,
      );
    }
  }

  // Races the web-push send against a wall-clock timeout so a stalled endpoint
  // can't hold an unresolved promise open. The timer is always cleared so a
  // completed send doesn't leave a pending timeout ref'ing the event loop.
  private async sendWithTimeout(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    body: string,
    agent: HttpsAgent,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('push-send-timeout')),
        PUSH_SEND_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([
        // `agent` pins the connection to the SSRF-validated IP (see caller).
        webPush.sendNotification(subscription, body, { agent }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
