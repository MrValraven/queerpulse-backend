import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MediaReferenceResolver } from '../media-references/media-reference.resolver';
import { Message } from '../messaging/entities/message.entity';
import { toBareKey } from './bare-key';
import { StorageService, StoredObject } from './storage.service';

// How many keys are checked for references per resolver call. The resolver's
// array sources run a `LIKE ANY(%key%)` per candidate, so an unbounded batch
// would build a pathological query; 200 keeps each pass cheap and the whole
// sweep incremental.
const REFERENCE_RESOLVE_BATCH_SIZE = 200;

// Read `process.env` at module load so `@Cron` gets a concrete schedule. An
// operator can override the cadence without a code change; the default is a
// quiet off-peak hour.
const ORPHAN_SWEEP_CRON =
  process.env.STORAGE_ORPHAN_SWEEP_CRON || CronExpression.EVERY_DAY_AT_4AM;

/**
 * Scheduled reclamation of orphaned storage objects (security review M10).
 *
 * A presigned PUT writes an object that no DB row references until (if ever) a
 * domain column is saved. Abandoned uploads (got the URL, never persisted a
 * draft) and replaced media (a new avatar leaves the old object behind) both
 * accumulate forever otherwise — Railway Buckets have no lifecycle rules, so the
 * sweep lives here.
 *
 * Safety is the whole design:
 *  - GRACE WINDOW: an object modified within the grace window is never touched,
 *    so a just-presigned-not-yet-persisted upload is safe.
 *  - REFERENCE CHECK: every candidate is run through `MediaReferenceResolver`
 *    (which answers "is this key referenced by any image column?") AND a
 *    `Message.attachment` lookup — message-image keys have NO resolver source,
 *    so without that second check a referenced DM image would be swept.
 *  - DEGRADED GUARD: if the resolver reports `degraded` (a source query threw),
 *    the batch is skipped entirely — an incomplete reference set is never
 *    treated as a green light to delete.
 *  - OFF + DRY-RUN BY DEFAULT: the job does nothing unless
 *    `STORAGE_ORPHAN_SWEEP_ENABLED=true`, and even then only LOGS candidates
 *    unless `STORAGE_ORPHAN_SWEEP_DRY_RUN=false`. Turning on real deletion is a
 *    deliberate ops decision.
 *  - DELETE CAP: at most `maxDeletesPerRun` objects go per tick, bounding the
 *    blast radius of any mistake; the next tick continues.
 *
 * Single-instance today (the app runs one scheduler). Idempotent: an overlapping
 * or repeated run simply re-evaluates whatever objects remain.
 */
@Injectable()
export class StorageMaintenanceService {
  private readonly logger = new Logger(StorageMaintenanceService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly storage: StorageService,
    private readonly mediaReferenceResolver: MediaReferenceResolver,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
  ) {}

  private get isEnabled(): boolean {
    return this.config.get<string>('STORAGE_ORPHAN_SWEEP_ENABLED') === 'true';
  }

  // Defaults to true: even with the job enabled, real deletion must be opted
  // into explicitly. Any value other than the literal `'false'` stays dry.
  private get isDryRun(): boolean {
    return this.config.get<string>('STORAGE_ORPHAN_SWEEP_DRY_RUN') !== 'false';
  }

  private get graceMilliseconds(): number {
    const hours = Number(
      this.config.get<string>('STORAGE_ORPHAN_SWEEP_GRACE_HOURS'),
    );
    const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 48;
    return safeHours * 60 * 60 * 1000;
  }

  private get maxDeletesPerRun(): number {
    const value = Number(
      this.config.get<string>('STORAGE_ORPHAN_SWEEP_MAX_DELETES'),
    );
    return Number.isFinite(value) && value > 0 ? value : 1000;
  }

  @Cron(ORPHAN_SWEEP_CRON)
  async sweepOrphanedObjects(): Promise<void> {
    if (!this.isEnabled) {
      return;
    }
    // A @nestjs/schedule handler that rejects becomes an unhandledRejection that
    // can crash the process; contain everything and let the next tick retry.
    try {
      await this.runSweep();
    } catch (error) {
      this.logger.error(`Orphan sweep failed: ${String(error)}`);
    }
  }

  private async runSweep(): Promise<void> {
    const graceCutoff = new Date(Date.now() - this.graceMilliseconds);
    const dryRun = this.isDryRun;
    const maxDeletes = this.maxDeletesPerRun;
    let examined = 0;
    let orphanCount = 0;
    let deletedCount = 0;
    let continuationToken: string | undefined;

    do {
      const page = await this.storage.listObjects({
        continuationToken,
        maxKeys: 1000,
      });
      continuationToken = page.nextContinuationToken ?? undefined;

      // Only objects OLDER than the grace window are eligible; an object with no
      // reported age is left alone (we never delete on missing metadata).
      const agedObjects = page.objects.filter(
        (object) =>
          object.lastModified !== null &&
          new Date(object.lastModified) < graceCutoff,
      );
      examined += agedObjects.length;

      for (
        let start = 0;
        start < agedObjects.length;
        start += REFERENCE_RESOLVE_BATCH_SIZE
      ) {
        const batch = agedObjects.slice(
          start,
          start + REFERENCE_RESOLVE_BATCH_SIZE,
        );
        const orphans = await this.orphansInBatch(batch);
        orphanCount += orphans.length;

        for (const orphanKey of orphans) {
          if (deletedCount >= maxDeletes) {
            this.logger.warn(
              `Orphan sweep hit the per-run delete cap (${maxDeletes}); remaining orphans deferred to the next run.`,
            );
            this.logSummary(examined, orphanCount, deletedCount, dryRun);
            return;
          }
          if (dryRun) {
            this.logger.log(`Orphan (dry-run, not deleted): ${orphanKey}`);
          } else {
            await this.storage.deleteObjectByKey(orphanKey);
            deletedCount += 1;
          }
        }
      }
    } while (continuationToken);

    this.logSummary(examined, orphanCount, deletedCount, dryRun);
  }

  // The keys in `batch` that are referenced by NOTHING: not by any image column
  // (via `MediaReferenceResolver`) and not by any message attachment. Returns an
  // empty list when the resolver is degraded, so an incomplete reference set is
  // never acted on.
  private async orphansInBatch(batch: StoredObject[]): Promise<string[]> {
    const bareKeys = batch.map((object) => toBareKey(object.key));
    const resolution = await this.mediaReferenceResolver.resolve(bareKeys);
    if (resolution.degraded) {
      this.logger.warn(
        'Media-reference resolution degraded; skipping this batch (no deletions).',
      );
      return [];
    }
    const messageReferencedKeys = await this.keysReferencedByMessages(bareKeys);
    const orphans: string[] = [];
    for (const object of batch) {
      const bareKey = toBareKey(object.key);
      if (resolution.references.has(bareKey)) {
        continue;
      }
      if (messageReferencedKeys.has(bareKey)) {
        continue;
      }
      orphans.push(object.key);
    }
    return orphans;
  }

  // Message-image attachments have no `MediaReferenceSource`, so they must be
  // checked directly or the sweep would delete DM images that are still in a
  // conversation. Matches both stored forms (bare key and the `/files/<key>`
  // URL) and includes soft-deleted messages (`withDeleted`) — a key any message
  // ever referenced is kept, the conservative direction for a delete sweep.
  private async keysReferencedByMessages(
    bareKeys: string[],
  ): Promise<Set<string>> {
    if (bareKeys.length === 0) {
      return new Set();
    }
    const attachmentForms = [
      ...bareKeys,
      ...bareKeys.map((bareKey) => `/files/${bareKey}`),
    ];
    const rows = await this.messages
      .createQueryBuilder('message')
      .withDeleted()
      .select("message.attachment ->> 'url'", 'url')
      .where("message.attachment ->> 'url' IN (:...attachmentForms)", {
        attachmentForms,
      })
      .getRawMany<{ url: string | null }>();
    const referenced = new Set<string>();
    for (const row of rows) {
      if (row.url) {
        referenced.add(toBareKey(row.url));
      }
    }
    return referenced;
  }

  private logSummary(
    examined: number,
    orphanCount: number,
    deletedCount: number,
    dryRun: boolean,
  ): void {
    this.logger.log(
      `Orphan sweep complete: examined ${examined} aged object(s), ${orphanCount} orphan(s) found, ${deletedCount} deleted${
        dryRun ? ' (dry-run: nothing actually deleted)' : ''
      }.`,
    );
  }
}
