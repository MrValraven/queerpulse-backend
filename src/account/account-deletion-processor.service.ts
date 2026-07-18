import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThanOrEqual, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import {
  EmailSuppression,
  hashSuppressedEmail,
} from './entities/email-suppression.entity';
import {
  DeletionRequest,
  DeletionRequestStatus,
} from './entities/deletion-request.entity';

/**
 * Executes the right to erasure. `POST /account/deletion-request` only *writes*
 * a `grace` row scheduled 30 days out; this is the thing that eventually makes
 * the erasure real.
 *
 * Single-instance job — safe here because the app runs one scheduler; if we
 * scale out, move this behind a distributed lock or a dedicated worker. (The
 * per-row claim below already makes a double tick harmless, but every replica
 * doing the same scan is still wasted work.)
 */
@Injectable()
export class AccountDeletionProcessorService {
  private readonly logger = new Logger(AccountDeletionProcessorService.name);

  constructor(
    @InjectRepository(DeletionRequest)
    private readonly deletionRequests: Repository<DeletionRequest>,
    private readonly dataSource: DataSource,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async processDueDeletions(): Promise<void> {
    // @nestjs/schedule does not wrap handlers, so an escaping rejection becomes
    // an unhandledRejection — which, absent a Sentry listener, takes the process
    // down. A DB blip must not restart the server; the next tick retries.
    try {
      await this.eraseDueAccounts();
    } catch (err) {
      this.logger.error(
        `Account erasure sweep failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    }
  }

  private async eraseDueAccounts(): Promise<void> {
    const now = new Date();
    const due = await this.deletionRequests.find({
      where: {
        status: DeletionRequestStatus.Grace,
        scheduledFor: LessThanOrEqual(now),
      },
    });
    for (const request of due) {
      // Claim the request *before* erasing. The conditional UPDATE only moves a
      // row that is still `grace`, so a concurrent run (or an overlapping tick)
      // that loses the race sees affected === 0 and skips — one account is never
      // erased twice, and a member who cancelled in the same instant (status
      // flipped to `cancelled`) can no longer be claimed at all.
      const claim = await this.deletionRequests.update(
        { id: request.id, status: DeletionRequestStatus.Grace },
        { status: DeletionRequestStatus.Processing },
      );
      if (claim.affected !== 1) {
        continue;
      }
      // Isolate each account: one erasure failing must not strand the rest of
      // the batch. A failure leaves the row parked in `processing` rather than
      // reverting it to `grace` — it is deliberately NOT auto-retried, because
      // a half-applied erasure needs a human to look at it, and `processing` is
      // the state the frontend already renders for "in progress".
      try {
        await this.eraseAccount(request.userId);
        await this.deletionRequests.update(
          { id: request.id },
          {
            status: DeletionRequestStatus.Erased,
            processedAt: new Date(),
          },
        );
        this.logger.log(`Erased account for deletion request ${request.id}`);
      } catch (err) {
        this.logger.error(
          `Erasure failed for deletion request ${request.id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
      }
    }
  }

  /**
   * Erase one member, in a single transaction so we never leave an account
   * half-erased (e.g. moderation history pseudonymized but the user row still
   * present, or worse, the reverse).
   *
   * Order matters:
   *  1. suppress the email — must be read off the user row *before* it is gone;
   *  2. pseudonymize the moderation history we are keeping;
   *  3. delete the user row, which cascades everything else away.
   */
  private async eraseAccount(userId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, { where: { id: userId } });
      if (!user) {
        // Already gone (manual DB surgery, or a prior partial run that got as
        // far as the delete). Nothing to erase — treat as success so the
        // request row can be stamped `erased` rather than retried forever.
        this.logger.warn(
          `Deletion request for ${userId} found no user row; treating as already erased`,
        );
        return;
      }

      // 1. Email suppression — "so we don't accidentally re-create your
      //    account". Idempotent: a re-run (or a member who somehow has two
      //    erased accounts on one address) must not trip the unique index.
      await manager
        .createQueryBuilder()
        .insert()
        .into(EmailSuppression)
        .values({
          emailHash: hashSuppressedEmail(user.email),
          reason: 'account_deleted',
        })
        .orIgnore()
        .execute();

      // 2. Preserve moderation history by severing it from the person, not by
      //    deleting it. Reports this member filed AGAINST OTHERS have to
      //    survive — otherwise erasing your account is a way to delete the
      //    evidence trail against everyone you ever reported. Same for the
      //    moderator action log: an erased moderator must not take the record
      //    of their decisions with them.
      //
      //    The FKs are `ON DELETE SET NULL` as of
      //    `AddDeletionErasureSupport1782800700000`, so step 3 would do this
      //    anyway; doing it explicitly here makes the intent legible and keeps
      //    the guarantee even if someone later "tidies" the FK rule back.
      await manager.query(
        `UPDATE "reports" SET "reporter_id" = NULL WHERE "reporter_id" = $1`,
        [userId],
      );
      await manager.query(
        `UPDATE "mod_audit_logs" SET "actor_id" = NULL WHERE "actor_id" = $1`,
        [userId],
      );

      // 3. Hard-delete the user. Every other member-owned table carries an
      //    `ON DELETE CASCADE` FK to `users("id")` and goes with it — 70+ FKs
      //    across the schema, verified against `src/migrations`.
      //
      //    NOTE for the next person: an earlier version of this brief claimed
      //    `activities`, `board_posts`, `shapings`, `skills` and
      //    `group_memberships` have NO FK to `users` and would be silently
      //    orphaned. That is NOT true — `AddProfileRichDetail1782692500000`
      //    adds `FK_<table>_user_id ... ON DELETE CASCADE` for all five in a
      //    loop (which is why a grep for their literal constraint names finds
      //    nothing). They cascade correctly; no explicit delete is needed, and
      //    adding one would imply a missing FK that is in fact present.
      //
      //    `deletion_request` itself is the one table that must NOT cascade —
      //    its FK was dropped in the same migration so this erasure ledger
      //    survives the row it describes.
      await manager.delete(User, { id: userId });
    });
  }
}
