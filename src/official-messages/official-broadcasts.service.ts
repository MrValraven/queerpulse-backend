import {
  ConflictException,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { In, Repository } from 'typeorm';
import { MessagingCoreService } from '../messaging/messaging-core.service';
import { Profile } from '../users/entities/profile.entity';
import { OfficialBroadcast } from './entities/official-broadcast.entity';
import { OfficialConversationsService } from './official-conversations.service';
import {
  OFFICIAL_BROADCAST_BATCH_SIZE,
  OFFICIAL_BROADCAST_HISTORY_LIMIT,
  OFFICIAL_BROADCAST_IDEMPOTENCY_CONFLICT_CODE,
  OFFICIAL_BROADCAST_LEASE_MINUTES,
  OFFICIAL_BROADCAST_MAX_ATTEMPTS,
  OFFICIAL_BROADCAST_POST_CONCURRENCY,
  OFFICIAL_BROADCAST_SENT_ACTION,
} from './official-messages.constants';
import {
  OfficialBroadcastResponse,
  toOfficialBroadcastResponse,
} from './official-messages-response';

/** Unfinished broadcasts the resume sweep picks up per tick. */
const RESUME_SWEEP_LIMIT = 10;

/**
 * PRD-372: "message every member" through their official thread.
 *
 * Accepting a broadcast writes the row and returns (202); delivery runs in the
 * background, in batches of `OFFICIAL_BROADCAST_BATCH_SIZE` active, non-system
 * members who existed when the broadcast was accepted, walked by keyset
 * pagination over `users.id` (never OFFSET, which rescans every earlier row
 * and skips or repeats members as the table changes).
 *
 * EXACTLY ONCE PER MEMBER. Each message is posted with
 * `clientMessageId = broadcast.id`. The existing unique index on
 * `(conversation_id, client_message_id)` plus the member's single official
 * thread means a second post of the same broadcast to the same member reads
 * the stored message back (`isNew: false`) instead of writing a copy.
 *
 * RESUMABLE. A worker claims a run with a lease (`lease_expires_at`) and an
 * ownership token (`lease_owner`, minted per claim), and renews both after
 * each batch in the UPDATE that also records the cursor and adds that batch's
 * delivered count. If the process dies mid-batch, the lease lapses, the
 * every-minute sweep reclaims the run and replays from the last recorded
 * cursor: the replayed members' messages already exist, are counted once (the
 * crashed batch never added its count, since cursor and count move in the same
 * statement), and are never posted twice.
 *
 * ONE WRITER AT A TIME. Every renewal and the completion carry `lease_owner`,
 * so a worker whose batch outlived the lease and was reclaimed elsewhere
 * matches no row, logs it and stops. Without that token the two workers both
 * wrote: `delivered_count` was incremented twice for the same members and the
 * slower worker wrote its older cursor back, sending the run over slices it
 * had already finished.
 *
 * ATTEMPTS COUNT FAILURES, NOT DEPLOYS. `attempt_count` ends a run that keeps
 * crashing as `failed`; a batch that makes progress resets it to zero, and a
 * clean shutdown hands the lease back and gives its attempt back, so restarts
 * during a long broadcast cannot fail a healthy run.
 *
 * A single member whose post fails (for example, their account was erased
 * between the page read and the post) is logged and skipped; the run carries
 * on, and `delivered_count < recipient_count` makes the gap visible.
 */
@Injectable()
export class OfficialBroadcastsService implements OnApplicationShutdown {
  private readonly logger = new Logger(OfficialBroadcastsService.name);
  /** Runs this process is delivering right now (the lease guards others). */
  private readonly activeBroadcastIds = new Set<string>();
  private isShuttingDown = false;

  constructor(
    @InjectRepository(OfficialBroadcast)
    private readonly broadcasts: Repository<OfficialBroadcast>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly officialConversations: OfficialConversationsService,
    private readonly core: MessagingCoreService,
  ) {}

  onApplicationShutdown(): void {
    this.isShuttingDown = true;
  }

  /**
   * Accepts a broadcast. Idempotent on `idempotencyKey`: the same key with the
   * same body and actor returns the existing row; the same key with anything
   * different is a 409, since silently returning a different broadcast than
   * the one just composed would be a lie.
   */
  async createBroadcast(
    body: string,
    idempotencyKey: string,
    actorId: string,
  ): Promise<OfficialBroadcastResponse> {
    const inserted: { id: string }[] = await this.broadcasts.query(
      `INSERT INTO "official_broadcasts" ("body", "actor_id", "idempotency_key", "recipient_count")
       VALUES ($1, $2, $3, (
         SELECT count(*)::int FROM "users"
         WHERE "status" = 'active' AND "is_system" = false
       ))
       ON CONFLICT ("idempotency_key") DO NOTHING
       RETURNING "id"`,
      [body, actorId, idempotencyKey],
    );
    const insertedId = inserted[0]?.id;
    if (!insertedId) {
      const existing = await this.broadcasts.findOneByOrFail({
        idempotencyKey,
      });
      if (existing.body !== body || existing.actorId !== actorId) {
        throw new ConflictException({
          statusCode: 409,
          message: 'That idempotency key belongs to a different broadcast',
          code: OFFICIAL_BROADCAST_IDEMPOTENCY_CONFLICT_CODE,
        });
      }
      return this.toResponse(existing);
    }
    const broadcast = await this.broadcasts.findOneByOrFail({ id: insertedId });
    await this.officialConversations.writeAudit({
      actorId,
      action: OFFICIAL_BROADCAST_SENT_ACTION,
      note: body,
    });
    // Fire and forget: the request answers 202 now. `deliver` never rejects.
    void this.deliver(broadcast.id);
    return this.toResponse(broadcast);
  }

  /** The newest broadcasts with their progress, actor names in one query. */
  async listBroadcasts(): Promise<OfficialBroadcastResponse[]> {
    const rows = await this.broadcasts.find({
      order: { createdAt: 'DESC' },
      take: OFFICIAL_BROADCAST_HISTORY_LIMIT,
    });
    const actorIds = [
      ...new Set(
        rows
          .map((row) => row.actorId)
          .filter((actorId): actorId is string => actorId !== null),
      ),
    ];
    const actorProfiles = actorIds.length
      ? await this.profiles.find({
          where: { userId: In(actorIds) },
          select: { userId: true, firstName: true, lastName: true },
        })
      : [];
    const nameByActor = new Map(
      actorProfiles.map((profile) => [
        profile.userId,
        `${profile.firstName} ${profile.lastName}`.trim(),
      ]),
    );
    return rows.map((row) =>
      toOfficialBroadcastResponse(
        row,
        row.actorId ? (nameByActor.get(row.actorId) ?? null) : null,
      ),
    );
  }

  /** Every minute: finish anything a crash or restart left unfinished. */
  @Cron(CronExpression.EVERY_MINUTE)
  async resumeUnfinishedBroadcasts(): Promise<void> {
    try {
      await this.broadcasts.query(
        `UPDATE "official_broadcasts"
         SET "status" = 'failed', "completed_at" = now(), "lease_expires_at" = NULL
         WHERE "status" IN ('pending', 'sending')
           AND "attempt_count" >= $1
           AND ("lease_expires_at" IS NULL OR "lease_expires_at" < now())`,
        [OFFICIAL_BROADCAST_MAX_ATTEMPTS],
      );
      const unfinished: { id: string }[] = await this.broadcasts.query(
        `SELECT "id" FROM "official_broadcasts"
         WHERE "status" IN ('pending', 'sending')
           AND ("lease_expires_at" IS NULL OR "lease_expires_at" < now())
         ORDER BY "created_at" ASC
         LIMIT $1`,
        [RESUME_SWEEP_LIMIT],
      );
      for (const row of unfinished) {
        if (this.isShuttingDown) return;
        await this.deliver(row.id);
      }
    } catch (error) {
      // An escaping rejection from a @nestjs/schedule handler becomes an
      // unhandledRejection; log and let the next tick retry.
      this.logger.error(`Broadcast resume sweep failed: ${String(error)}`);
    }
  }

  /** Claims and delivers one broadcast. Never rejects. */
  private async deliver(broadcastId: string): Promise<void> {
    if (this.activeBroadcastIds.has(broadcastId)) return;
    this.activeBroadcastIds.add(broadcastId);
    let heldLeaseOwner: string | null = null;
    try {
      const claimed = await this.claim(broadcastId);
      if (!claimed) return;
      heldLeaseOwner = claimed.leaseOwner;
      await this.deliverClaimed(claimed);
    } catch (error) {
      this.logger.error(
        `Broadcast ${broadcastId} delivery stopped: ${String(error)}`,
      );
      // Release the lease so the next sweep resumes from the saved cursor.
      // This run DID fail, so the attempt stands.
      if (heldLeaseOwner) {
        await this.releaseLease(broadcastId, heldLeaseOwner, false);
      }
    } finally {
      this.activeBroadcastIds.delete(broadcastId);
    }
  }

  /**
   * Takes the run, minting the `lease_owner` token this worker proves itself
   * with on every later write. Reads the row back so the caller carries the
   * token it just minted; the claim leaves `lease_expires_at` in the future,
   * so no concurrent claim can have replaced it in between.
   */
  private async claim(broadcastId: string): Promise<OfficialBroadcast | null> {
    const leaseOwner = randomUUID();
    const claimedRows: { id: string }[] = await this.broadcasts.query(
      `UPDATE "official_broadcasts"
       SET "status" = 'sending',
           "lease_expires_at" = now() + make_interval(mins => $2),
           "lease_owner" = $4::uuid,
           "attempt_count" = "attempt_count" + 1
       WHERE "id" = $1
         AND "status" IN ('pending', 'sending')
         AND "attempt_count" < $3
         AND ("lease_expires_at" IS NULL OR "lease_expires_at" < now())
       RETURNING "id"`,
      [
        broadcastId,
        OFFICIAL_BROADCAST_LEASE_MINUTES,
        OFFICIAL_BROADCAST_MAX_ATTEMPTS,
        leaseOwner,
      ],
    );
    if (claimedRows.length === 0) return null;
    return this.broadcasts.findOneBy({ id: broadcastId });
  }

  /**
   * Hands the run back so the next sweep resumes it from the saved cursor.
   * Conditional on the lease token: a worker whose lease already lapsed and
   * was re-claimed elsewhere must not clear the new owner's claim.
   *
   * `shouldRefundAttempt` is for a clean shutdown. `claim` counts every claim
   * and `resumeUnfinishedBroadcasts` fails a run at
   * `OFFICIAL_BROADCAST_MAX_ATTEMPTS`, so five deploys landing mid-broadcast
   * used to fail a perfectly healthy run that nothing then retried. Giving the
   * attempt back keeps the counter for what it is meant to bound: runs that
   * keep crashing.
   */
  private async releaseLease(
    broadcastId: string,
    leaseOwner: string,
    shouldRefundAttempt: boolean,
  ): Promise<void> {
    await this.broadcasts
      .query(
        `UPDATE "official_broadcasts"
         SET "lease_expires_at" = NULL,
             "lease_owner" = NULL,
             "attempt_count" = CASE
               WHEN $3::boolean THEN GREATEST("attempt_count" - 1, 0)
               ELSE "attempt_count"
             END
         WHERE "id" = $1 AND "lease_owner" = $2::uuid`,
        [broadcastId, leaseOwner, shouldRefundAttempt],
      )
      .catch((releaseError: unknown) =>
        this.logger.error(
          `Broadcast ${broadcastId} lease release failed: ${String(releaseError)}`,
        ),
      );
  }

  private async deliverClaimed(broadcast: OfficialBroadcast): Promise<void> {
    const leaseOwner = broadcast.leaseOwner;
    if (!leaseOwner) {
      this.logger.error(
        `Broadcast ${broadcast.id} was claimed without a lease token; leaving it for the next sweep.`,
      );
      return;
    }
    const senderId = await this.officialConversations.resolveOfficialSenderId();
    let cursorUserId = broadcast.cursorUserId;
    for (;;) {
      if (this.isShuttingDown) {
        // Hand the lease back instead of walking away from it. Returning with
        // the row still `sending` and a live lease meant the next sweep had to
        // wait out OFFICIAL_BROADCAST_LEASE_MINUTES before it could resume,
        // and the claim this shutdown interrupted was counted as an attempt.
        await this.releaseLease(broadcast.id, leaseOwner, true);
        return;
      }
      const page: { id: string }[] = await this.broadcasts.query(
        `SELECT "id" FROM "users"
         WHERE "status" = 'active'
           AND "is_system" = false
           AND "created_at" <= $1
           AND ($2::uuid IS NULL OR "id" > $2::uuid)
         ORDER BY "id" ASC
         LIMIT $3`,
        [broadcast.createdAt, cursorUserId, OFFICIAL_BROADCAST_BATCH_SIZE],
      );
      if (page.length === 0) break;
      const memberIds = page.map((row) => row.id);
      const conversationIdByMember =
        await this.officialConversations.getOrCreateOfficialConversations(
          memberIds,
        );
      const deliveredInBatch = await this.postToMembers(
        broadcast,
        senderId,
        memberIds,
        conversationIdByMember,
      );
      cursorUserId = memberIds[memberIds.length - 1] ?? cursorUserId;
      // Cursor, count and renewal in one statement, all of it conditional on
      // still owning the lease: a worker that lost it writes nothing, so it
      // can neither double-count the batch nor drag the cursor backwards over
      // slices the new owner has already finished. `attempt_count` goes back
      // to zero because a batch that lands is progress, and the counter exists
      // to end runs that make none.
      const renewedRows: { id: string }[] = await this.broadcasts.query(
        `UPDATE "official_broadcasts"
         SET "cursor_user_id" = $2,
             "delivered_count" = "delivered_count" + $3,
             "lease_expires_at" = now() + make_interval(mins => $4),
             "attempt_count" = 0
         WHERE "id" = $1
           AND "lease_owner" = $5::uuid
           AND "lease_expires_at" > now()
         RETURNING "id"`,
        [
          broadcast.id,
          cursorUserId,
          deliveredInBatch,
          OFFICIAL_BROADCAST_LEASE_MINUTES,
          leaseOwner,
        ],
      );
      if (renewedRows.length === 0) {
        this.logger.warn(
          `Broadcast ${broadcast.id} lost its lease mid-run; another worker owns it now.`,
        );
        return;
      }
      if (page.length < OFFICIAL_BROADCAST_BATCH_SIZE) break;
    }
    const completedRows: { id: string }[] = await this.broadcasts.query(
      `UPDATE "official_broadcasts"
       SET "status" = 'completed',
           "completed_at" = now(),
           "lease_expires_at" = NULL,
           "lease_owner" = NULL
       WHERE "id" = $1
         AND "lease_owner" = $2::uuid
         AND "lease_expires_at" > now()
       RETURNING "id"`,
      [broadcast.id, leaseOwner],
    );
    if (completedRows.length === 0) {
      this.logger.warn(
        `Broadcast ${broadcast.id} finished its walk without holding the lease; its current owner will complete it.`,
      );
    }
  }

  /**
   * Posts to one batch through a sliding pool of
   * `OFFICIAL_BROADCAST_POST_CONCURRENCY`: a new post starts the moment any
   * running one settles, so one slow member never holds up the other nine
   * slots.
   *
   * Returns how many members NOW HOLD this broadcast, which on a replayed
   * batch includes the members whose copy `postMessage` read back instead of
   * writing (`isNew: false`). That is what keeps a resumed run's total right:
   * the crashed batch's count was never recorded, because the cursor and the
   * count move in the same statement, so the replay is the only chance those
   * members have to be counted. They still cannot be counted twice, since the
   * renewal that records the count is lease-owned and only one worker can
   * hold the lease.
   */
  private async postToMembers(
    broadcast: OfficialBroadcast,
    senderId: string,
    memberIds: string[],
    conversationIdByMember: Map<string, string>,
  ): Promise<number> {
    let deliveredCount = 0;
    let nextIndex = 0;
    const postNext = async (): Promise<void> => {
      while (nextIndex < memberIds.length) {
        const memberId = memberIds[nextIndex];
        nextIndex += 1;
        const conversationId = memberId
          ? conversationIdByMember.get(memberId)
          : undefined;
        if (!conversationId) continue;
        try {
          await this.core.postMessage(
            conversationId,
            senderId,
            broadcast.body,
            undefined,
            broadcast.id,
          );
          deliveredCount += 1;
        } catch (error) {
          this.logger.warn(
            `Broadcast ${broadcast.id} skipped member ${memberId}: ${String(error)}`,
          );
        }
      }
    };
    const workers = Array.from(
      {
        length: Math.min(OFFICIAL_BROADCAST_POST_CONCURRENCY, memberIds.length),
      },
      () => postNext(),
    );
    await Promise.all(workers);
    return deliveredCount;
  }

  private async toResponse(
    broadcast: OfficialBroadcast,
  ): Promise<OfficialBroadcastResponse> {
    const actorProfile = broadcast.actorId
      ? await this.profiles.findOne({
          where: { userId: broadcast.actorId },
          select: { userId: true, firstName: true, lastName: true },
        })
      : null;
    return toOfficialBroadcastResponse(
      broadcast,
      actorProfile
        ? `${actorProfile.firstName} ${actorProfile.lastName}`.trim()
        : null,
    );
  }
}
