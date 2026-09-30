import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { isUniqueViolation } from '../../common/db-errors';
import { runWithConcurrency } from '../../common/run-with-concurrency';
import { NotificationType } from '../../notifications/entities/notification.entity';
import { NotificationsService } from '../../notifications/notifications.service';
import { StorageService } from '../../storage/storage.service';
import { User, UserStatus } from '../../users/entities/user.entity';
import { SubprofileFeedEntry } from '../entities/subprofile-feed-entry.entity';
import {
  FeedErrorCode,
  SubprofileFeed,
} from '../entities/subprofile-feed.entity';
import {
  SubprofileItem,
  SubprofileSection,
} from '../entities/subprofile-item.entity';
import { SubprofileMember } from '../entities/subprofile-member.entity';
import { Subprofile } from '../entities/subprofile.entity';
import { isSectionAllowed } from '../subprofile-kinds';
import { MAX_ITEMS_PER_SECTION } from '../subprofile-validation';
import { SECTION_FULL_CODE, SubprofilesService } from '../subprofiles.service';
import { ConnectFeedDTO } from './dto/connect-feed.dto';
import { UpdateFeedDTO } from './dto/update-feed.dto';
import { FeedFetchError, type ConditionalValidators } from './feed-fetch';
import { episodeToItemFields } from './feed-item-mapping';
import { NotAFeedError, type ParsedFeed, parsePodcastFeed } from './feed-parse';
import {
  FeedEntryCounts,
  FeedEntryDTO,
  FeedPreviewDTO,
  PublishFeedEntriesResponse,
  SubprofileFeedDTO,
  toEntryDTO,
  toEpisodeFields,
  toFeedDTO,
} from './feed-response';
import {
  MANUAL_SYNC_COOLDOWN_MS,
  MAX_FEEDS_PER_SUBPROFILE,
  manualSyncWaitMs,
  nextCheckAfterFailure,
  nextCheckAfterSuccess,
} from './feed-schedule';
import { normalizeFeedUrl } from './feed-url';
import { SubprofileFeedFetcher } from './subprofile-feed-fetcher';

/** Episodes shown in a preview. */
const PREVIEW_EPISODES = 5;
/** Entries one review list returns. */
const MAX_LISTED_ENTRIES = 500;
/** Rows per INSERT when recording a feed's episodes. */
const ENTRY_INSERT_CHUNK = 100;
/** Distinct pieces of episode art one publish downloads. Past this, episodes
 *  fall back to the show art, so a publish of 100 episodes that each carry
 *  their own art cannot hold a request open for minutes. */
export const MAX_ART_DOWNLOADS_PER_PUBLISH = 20;
/** Concurrent art downloads within one publish. */
const ART_DOWNLOAD_CONCURRENCY = 4;

export const FEED_ALREADY_CONNECTED_CODE = 'FEED_ALREADY_CONNECTED';
export const FEED_LIMIT_CODE = 'FEED_LIMIT';
export const SYNC_TOO_SOON_CODE = 'SYNC_TOO_SOON';

/** Who a sync acts for. A manual sync acts as the member who pressed it; a
 *  scheduled one acts as the feed's creator, and only while they may. */
export type FeedSyncMode =
  { kind: 'manual'; userId: string } | { kind: 'scheduled' };

type FeedRead =
  | { notModified: true }
  | {
      notModified: false;
      parsed: ParsedFeed;
      finalUrl: string;
      etag: string | null;
      lastModified: string | null;
    };

/** Newest first: publish date descending (undated last), then newest row. */
function newestFirst(
  left: SubprofileFeedEntry,
  right: SubprofileFeedEntry,
): number {
  const leftTime = left.publishedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const rightTime = right.publishedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return right.createdAt.getTime() - left.createdAt.getTime();
}

/**
 * Persona feed import (podcast RSS): connect a feed to a persona, keep it in
 * sync, and publish its episodes into a section.
 *
 * Episodes are STAGED in `subprofile_feed_entries` rather than written into
 * `subprofile_items` as drafts, because a section save replaces the section
 * and pairs rows by position: a draft item would be overwritten by the
 * owner's next save. Publishing inserts ordinary items at the top of the
 * section through `SubprofilesService.insertItemsAtTop`, the same persona
 * lock and edit-version bump every editor write takes.
 *
 * A sync only ever INSERTS entries for guids it has not seen. It never
 * rewrites an entry or an item, so nothing an owner edited on QueerPulse is
 * overwritten by a later check of the feed.
 *
 * Remote art is never stored or returned: it is downloaded (SSRF-safe, magic
 * bytes checked) into our own storage as a `work-image` key owned by the
 * member doing the publish, and only that key reaches an item or a response.
 */
@Injectable()
export class SubprofileFeedsService {
  private readonly logger = new Logger(SubprofileFeedsService.name);

  constructor(
    @InjectRepository(SubprofileFeed)
    private readonly feeds: Repository<SubprofileFeed>,
    @InjectRepository(SubprofileFeedEntry)
    private readonly entries: Repository<SubprofileFeedEntry>,
    @InjectRepository(SubprofileItem)
    private readonly items: Repository<SubprofileItem>,
    @InjectRepository(SubprofileMember)
    private readonly members: Repository<SubprofileMember>,
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly subprofilesService: SubprofilesService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
    private readonly fetcher: SubprofileFeedFetcher,
    private readonly dataSource: DataSource,
  ) {}

  // ---- preview -------------------------------------------------------------

  async preview(
    userId: string,
    rawUrl: string,
    subprofileId?: string,
  ): Promise<FeedPreviewDTO> {
    if (subprofileId) {
      await this.subprofilesService.getOwned(userId, subprofileId);
    }
    const url = this.normalizeOrThrow(rawUrl);
    const read = await this.readFeedOrThrow(url);
    if (read.notModified) {
      // Unreachable: no validators were sent.
      throw new UnprocessableEntityException({
        code: 'http_error' satisfies FeedErrorCode,
        message: 'The feed answered an unconditional request with 304.',
      });
    }
    const alreadyConnected = subprofileId
      ? await this.feeds.exists({
          where: {
            subprofileId,
            feedUrl: In([...new Set([url, read.finalUrl])]),
          },
        })
      : false;
    return {
      feedUrl: read.finalUrl,
      title: read.parsed.title ?? '',
      author: read.parsed.author,
      description: read.parsed.description,
      episodeCount: read.parsed.episodeCount,
      latest: read.parsed.episodes
        .slice(0, PREVIEW_EPISODES)
        .map(toEpisodeFields),
      alreadyConnected,
    };
  }

  // ---- feeds ---------------------------------------------------------------

  async list(
    userId: string,
    subprofileId: string,
  ): Promise<SubprofileFeedDTO[]> {
    await this.subprofilesService.getOwned(userId, subprofileId);
    const feeds = await this.feeds.find({
      where: { subprofileId },
      order: { createdAt: 'ASC' },
    });
    return this.toFeedDTOs(feeds);
  }

  async connect(
    userId: string,
    subprofileId: string,
    dto: ConnectFeedDTO,
  ): Promise<SubprofileFeedDTO> {
    const persona = await this.subprofilesService.getOwned(
      userId,
      subprofileId,
    );
    const section = this.assertImportSection(persona, dto.section);
    await this.assertUnderFeedLimit(this.feeds.manager, subprofileId);
    const url = this.normalizeOrThrow(dto.url);
    await this.assertNotConnected(subprofileId, [url]);

    const read = await this.readFeedOrThrow(url);
    if (read.notModified) {
      throw new UnprocessableEntityException({
        code: 'http_error' satisfies FeedErrorCode,
        message: 'The feed answered an unconditional request with 304.',
      });
    }
    await this.assertNotConnected(subprofileId, [read.finalUrl]);

    // Show art is best-effort and fetched BEFORE the transaction: network I/O
    // never runs while a row lock is held.
    const imageKey = read.parsed.imageUrl
      ? await this.storeArt(read.parsed.imageUrl, userId)
      : null;

    const now = new Date();
    let feedId: string;
    try {
      feedId = await this.dataSource.transaction(async (manager) => {
        // Serializes concurrent connects on one persona, so two of them cannot
        // both pass the per-persona cap.
        await manager.findOne(Subprofile, {
          where: { id: subprofileId },
          lock: { mode: 'pessimistic_write' },
        });
        await this.assertUnderFeedLimit(manager, subprofileId);
        const feed = await manager.save(
          manager.create(SubprofileFeed, {
            subprofileId,
            createdById: userId,
            feedUrl: read.finalUrl,
            section,
            title: read.parsed.title,
            author: read.parsed.author,
            imageKey,
            autoPublish: dto.autoPublish ?? false,
            etag: read.etag,
            lastModified: read.lastModified,
            lastSyncedAt: now,
            lastAttemptAt: now,
            nextCheckAt: nextCheckAfterSuccess(now),
            consecutiveFailures: 0,
            lastError: null,
          }),
        );
        // `all`: the whole back catalogue waits for review. `none`: it is
        // recorded as dismissed, so it is never offered as "new" but can be
        // restored from the dismissed list.
        await this.insertEntries(
          manager,
          feed,
          read.parsed,
          dto.backfill === 'all' ? 'pending' : 'dismissed',
        );
        return feed.id;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'UQ_subprofile_feeds_subprofile_feed_url')) {
        throw this.alreadyConnected();
      }
      throw error;
    }
    return this.getFeedDTO(subprofileId, feedId);
  }

  async update(
    userId: string,
    subprofileId: string,
    feedId: string,
    dto: UpdateFeedDTO,
  ): Promise<SubprofileFeedDTO> {
    const persona = await this.subprofilesService.getOwned(
      userId,
      subprofileId,
    );
    await this.findFeed(subprofileId, feedId);
    const patch: Partial<Pick<SubprofileFeed, 'section' | 'autoPublish'>> = {};
    if (dto.section !== undefined) {
      patch.section = this.assertImportSection(persona, dto.section);
    }
    if (dto.autoPublish !== undefined) patch.autoPublish = dto.autoPublish;
    if (Object.keys(patch).length) {
      await this.feeds.update({ id: feedId, subprofileId }, patch);
    }
    return this.getFeedDTO(subprofileId, feedId);
  }

  /** Disconnect a feed. Items already published from it stay; its pending and
   *  dismissed entries go with it (FK cascade). */
  async remove(
    userId: string,
    subprofileId: string,
    feedId: string,
  ): Promise<void> {
    await this.subprofilesService.getOwned(userId, subprofileId);
    await this.findFeed(subprofileId, feedId);
    await this.feeds.delete({ id: feedId, subprofileId });
  }

  /** Check a feed now. 429 when it was checked less than five minutes ago. */
  async syncNow(
    userId: string,
    subprofileId: string,
    feedId: string,
  ): Promise<SubprofileFeedDTO> {
    await this.subprofilesService.getOwned(userId, subprofileId);
    const feed = await this.findFeed(subprofileId, feedId);
    const now = new Date();
    // Claimed atomically: two presses (or a press racing the scheduler's own
    // stamp) cannot both pass the cooldown.
    const claim = await this.feeds
      .createQueryBuilder()
      .update(SubprofileFeed)
      .set({ lastAttemptAt: now })
      .where('id = :feedId', { feedId })
      .andWhere('(last_attempt_at IS NULL OR last_attempt_at <= :cutoff)', {
        cutoff: new Date(now.getTime() - MANUAL_SYNC_COOLDOWN_MS),
      })
      .execute();
    if (!claim.affected) {
      const retryAfterMs = Math.max(
        1000,
        manualSyncWaitMs(feed.lastAttemptAt, now),
      );
      throw new HttpException(
        {
          code: SYNC_TOO_SOON_CODE,
          message: 'This feed was checked a moment ago. Try again shortly.',
          retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await this.syncFeed(feed, { kind: 'manual', userId }, now);
    return this.getFeedDTO(subprofileId, feedId);
  }

  // ---- entries -------------------------------------------------------------

  async listEntries(
    userId: string,
    subprofileId: string,
    feedId: string,
    status?: SubprofileFeedEntry['status'],
  ): Promise<FeedEntryDTO[]> {
    await this.subprofilesService.getOwned(userId, subprofileId);
    await this.findFeed(subprofileId, feedId);
    const rows = await this.entries.find({
      where: { feedId, ...(status ? { status } : {}) },
      order: {
        publishedAt: { direction: 'DESC', nulls: 'LAST' },
        createdAt: 'DESC',
      },
      take: MAX_LISTED_ENTRIES,
    });
    return rows.map(toEntryDTO);
  }

  async publish(
    userId: string,
    subprofileId: string,
    feedId: string,
    entryIds: string[],
    expectedEditVersion?: number,
  ): Promise<PublishFeedEntriesResponse> {
    await this.subprofilesService.getOwned(userId, subprofileId);
    const feed = await this.findFeed(subprofileId, feedId);
    return this.publishEntries(feed, userId, entryIds, expectedEditVersion);
  }

  async dismiss(
    userId: string,
    subprofileId: string,
    feedId: string,
    entryIds: string[],
  ): Promise<{ dismissed: number }> {
    await this.subprofilesService.getOwned(userId, subprofileId);
    await this.findFeed(subprofileId, feedId);
    const result = await this.entries.update(
      { feedId, id: In([...new Set(entryIds)]), status: 'pending' },
      { status: 'dismissed' },
    );
    return { dismissed: result.affected ?? 0 };
  }

  async restore(
    userId: string,
    subprofileId: string,
    feedId: string,
    entryIds: string[],
  ): Promise<{ restored: number }> {
    await this.subprofilesService.getOwned(userId, subprofileId);
    await this.findFeed(subprofileId, feedId);
    const result = await this.entries.update(
      { feedId, id: In([...new Set(entryIds)]), status: 'dismissed' },
      { status: 'pending' },
    );
    return { restored: result.affected ?? 0 };
  }

  /**
   * Publish pending entries of `feed` into its section as `publisherUserId`,
   * newest first, filling whatever room the section has left. Entries that do
   * not fit, and ids that are not pending entries of this feed, are counted
   * as `skipped`; the ones that did not fit stay pending.
   */
  async publishEntries(
    feed: SubprofileFeed,
    publisherUserId: string,
    entryIds: string[],
    expectedEditVersion?: number,
  ): Promise<PublishFeedEntriesResponse> {
    const requestedIds = [...new Set(entryIds)];
    const pending = (
      await this.entries.find({
        where: { feedId: feed.id, id: In(requestedIds), status: 'pending' },
      })
    ).sort(newestFirst);
    if (!pending.length) {
      return {
        published: 0,
        skipped: requestedIds.length,
        subprofile: await this.subprofilesService.getOwnedDTO(
          publisherUserId,
          feed.subprofileId,
        ),
      };
    }

    // An unlocked estimate of the room, so art is only downloaded for
    // episodes that can land. `insertItemsAtTop` re-counts under the lock and
    // is what actually enforces the cap.
    const existingCount = await this.items.count({
      where: { subprofileId: feed.subprofileId, section: feed.section },
    });
    const room = MAX_ITEMS_PER_SECTION - existingCount;
    if (room <= 0) {
      throw new UnprocessableEntityException({
        code: SECTION_FULL_CODE,
        message: `A section can have at most ${MAX_ITEMS_PER_SECTION} items`,
      });
    }
    const prepared = pending.slice(0, room);
    const imageKeys = await this.storeEpisodeArt(
      prepared,
      feed.imageKey,
      publisherUserId,
    );
    const preparedIds = prepared.map((entry) => entry.id);

    const result = await this.subprofilesService.insertItemsAtTop<string>(
      publisherUserId,
      feed.subprofileId,
      feed.section,
      {
        expectedEditVersion,
        // Re-read under the persona lock (and row-lock the entries), so a
        // concurrent publish or dismiss of the same episodes is seen here.
        selectCandidates: async (manager) => {
          const stillPending = await manager.find(SubprofileFeedEntry, {
            where: { id: In(preparedIds), feedId: feed.id, status: 'pending' },
            lock: { mode: 'pessimistic_write' },
          });
          const stillPendingIds = new Set(stillPending.map((row) => row.id));
          return prepared
            .filter((entry) => stillPendingIds.has(entry.id))
            .map((entry) => ({
              ref: entry.id,
              fields: episodeToItemFields(
                entry,
                imageKeys.get(entry.id) ?? null,
              ),
            }));
        },
        onInserted: async (manager, inserted) => {
          for (const { ref, itemId } of inserted) {
            await manager.update(
              SubprofileFeedEntry,
              { id: ref },
              { status: 'published', itemId },
            );
          }
        },
      },
    );
    return {
      published: result.inserted,
      skipped: requestedIds.length - result.inserted,
      subprofile: result.subprofile,
    };
  }

  // ---- sync ----------------------------------------------------------------

  /**
   * Check one feed and record what is new. Never throws for a feed that
   * cannot be read: that is recorded on the feed (failure count, backoff,
   * `lastError`) and is the scheduler's normal business.
   *
   * New episodes become pending entries, or are published straight away when
   * the feed auto-publishes and someone may publish them (the pressing member
   * for a manual sync, the feed's creator for a scheduled one: still a
   * member, active, not restricted). A scheduled sync that leaves new
   * episodes pending tells the persona's members.
   */
  async syncFeed(
    feed: SubprofileFeed,
    mode: FeedSyncMode,
    now: Date = new Date(),
  ): Promise<{ newEntryCount: number; newPendingCount: number }> {
    const validators: ConditionalValidators = {
      etag: feed.etag,
      lastModified: feed.lastModified,
    };
    let read: FeedRead;
    try {
      read = await this.readFeed(feed.feedUrl, validators);
    } catch (error) {
      if (!(error instanceof FeedFetchError)) throw error;
      const consecutiveFailures = feed.consecutiveFailures + 1;
      await this.feeds.update(
        { id: feed.id },
        {
          lastAttemptAt: now,
          consecutiveFailures,
          lastError: error.code,
          nextCheckAt: nextCheckAfterFailure(now, consecutiveFailures),
        },
      );
      return { newEntryCount: 0, newPendingCount: 0 };
    }

    const success: Partial<SubprofileFeed> = {
      lastAttemptAt: now,
      lastSyncedAt: now,
      consecutiveFailures: 0,
      lastError: null,
      nextCheckAt: nextCheckAfterSuccess(now),
    };
    if (read.notModified) {
      await this.feeds.update({ id: feed.id }, success);
      return { newEntryCount: 0, newPendingCount: 0 };
    }

    const actingUserId =
      mode.kind === 'manual' ? mode.userId : await this.eligibleCreator(feed);
    const patch: Partial<SubprofileFeed> = {
      ...success,
      title: read.parsed.title,
      author: read.parsed.author,
      etag: read.etag,
      lastModified: read.lastModified,
    };
    if (!feed.imageKey && read.parsed.imageUrl && actingUserId) {
      const imageKey = await this.storeArt(read.parsed.imageUrl, actingUserId);
      if (imageKey) {
        patch.imageKey = imageKey;
        feed.imageKey = imageKey;
      }
    }

    const newEntryIds = await this.insertEntries(
      this.entries.manager,
      feed,
      read.parsed,
      'pending',
    );
    await this.feeds.update({ id: feed.id }, patch);
    if (!newEntryIds.length) return { newEntryCount: 0, newPendingCount: 0 };

    // Re-read the feed: the owner may have changed `autoPublish` or the
    // section while this sync was fetching.
    const current = await this.feeds.findOne({ where: { id: feed.id } });
    if (current?.autoPublish && actingUserId) {
      try {
        await this.publishEntries(current, actingUserId, newEntryIds);
      } catch (error) {
        // A full section, a publisher who just left, a section the kind no
        // longer has: the episodes simply stay pending for review.
        this.logger.warn(
          `Auto-publish for feed ${feed.id} left episodes pending: ${String(error)}`,
        );
      }
    }

    const newPendingCount = await this.entries.count({
      where: { id: In(newEntryIds), status: 'pending' },
    });
    if (mode.kind === 'scheduled' && newPendingCount > 0 && current) {
      await this.notifyMembers(current, newPendingCount);
    }
    return { newEntryCount: newEntryIds.length, newPendingCount };
  }

  // ---- helpers -------------------------------------------------------------

  /** Record every parsed episode this feed has not seen, returning the new
   *  entries' ids. Idempotent under a concurrent sync (`ON CONFLICT DO
   *  NOTHING` on the (feed, guid) key). */
  private async insertEntries(
    manager: EntityManager,
    feed: SubprofileFeed,
    parsed: ParsedFeed,
    status: 'pending' | 'dismissed',
  ): Promise<string[]> {
    if (!parsed.episodes.length) return [];
    const known = await manager.find(SubprofileFeedEntry, {
      where: {
        feedId: feed.id,
        guid: In(parsed.episodes.map((episode) => episode.guid)),
      },
      select: { guid: true },
    });
    const knownGuids = new Set(known.map((row) => row.guid));
    const rows = parsed.episodes
      .filter((episode) => !knownGuids.has(episode.guid))
      .map((episode) => ({
        feedId: feed.id,
        subprofileId: feed.subprofileId,
        guid: episode.guid,
        title: episode.title,
        description: episode.description,
        link: episode.link,
        publishedAt: episode.publishedAt,
        durationSeconds: episode.durationSeconds,
        season: episode.season,
        episode: episode.episode,
        remoteImageUrl: episode.imageUrl,
        status,
        itemId: null,
      }));
    const insertedIds: string[] = [];
    for (let offset = 0; offset < rows.length; offset += ENTRY_INSERT_CHUNK) {
      const result = await manager
        .createQueryBuilder()
        .insert()
        .into(SubprofileFeedEntry)
        .values(rows.slice(offset, offset + ENTRY_INSERT_CHUNK))
        .orIgnore()
        .returning(['id'])
        .execute();
      for (const raw of result.raw as { id?: unknown }[]) {
        if (typeof raw.id === 'string') insertedIds.push(raw.id);
      }
    }
    return insertedIds;
  }

  /** Download each episode's art once (deduplicated by URL, capped per
   *  publish) and store our copy; an episode without usable art falls back
   *  to the show art, else null. */
  private async storeEpisodeArt(
    entries: SubprofileFeedEntry[],
    showImageKey: string | null,
    ownerUserId: string,
  ): Promise<Map<string, string | null>> {
    const uniqueUrls = [
      ...new Set(
        entries
          .map((entry) => entry.remoteImageUrl)
          .filter((url): url is string => Boolean(url)),
      ),
    ].slice(0, MAX_ART_DOWNLOADS_PER_PUBLISH);
    const keys = await runWithConcurrency(
      uniqueUrls.map((url) => () => this.storeArt(url, ownerUserId)),
      ART_DOWNLOAD_CONCURRENCY,
    );
    const keyByUrl = new Map(
      uniqueUrls.map((url, index) => [url, keys[index]]),
    );
    return new Map(
      entries.map((entry) => [
        entry.id,
        (entry.remoteImageUrl ? keyByUrl.get(entry.remoteImageUrl) : null) ??
          showImageKey,
      ]),
    );
  }

  /** Our stored copy of one piece of remote art, or null. Never throws. */
  private async storeArt(
    remoteUrl: string,
    ownerUserId: string,
  ): Promise<string | null> {
    try {
      const image = await this.fetcher.fetchImage(remoteUrl);
      if (!image) return null;
      return await this.storage.putServerObject(
        'work-image',
        ownerUserId,
        image.bytes,
        image.contentType,
      );
    } catch (error) {
      this.logger.warn(`Could not store podcast art: ${String(error)}`);
      return null;
    }
  }

  /** The feed's creator, when a scheduled sync may act as them: still a
   *  member of the persona, an active account, not under a restriction. */
  private async eligibleCreator(feed: SubprofileFeed): Promise<string | null> {
    if (!feed.createdById) return null;
    const isMember = await this.members.exists({
      where: { subprofileId: feed.subprofileId, userId: feed.createdById },
    });
    if (!isMember) return null;
    const user = await this.users.findOne({
      where: { id: feed.createdById },
      select: {
        id: true,
        status: true,
        restricted: true,
        restrictedUntil: true,
      },
    });
    if (!user || user.status !== UserStatus.Active) return null;
    const isRestricted =
      user.restricted &&
      (user.restrictedUntil === null || user.restrictedUntil > new Date());
    return isRestricted ? null : user.id;
  }

  /** Best-effort bell for every member of the persona. */
  private async notifyMembers(
    feed: SubprofileFeed,
    newItemCount: number,
  ): Promise<void> {
    try {
      const persona = await this.subprofiles.findOne({
        where: { id: feed.subprofileId },
      });
      if (!persona) return;
      const memberRows = await this.members.find({
        where: { subprofileId: feed.subprofileId },
        select: { userId: true },
      });
      const recipientIds = memberRows.map((row) => row.userId);
      if (!recipientIds.length) return;
      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.PersonaImportReady,
        {
          subprofileId: persona.id,
          subprofileName: persona.displayName,
          subprofileSlugOrHandle: persona.handle ?? persona.slug,
          feedId: feed.id,
          feedTitle: feed.title,
          newItemCount,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Feed import notification failed for ${feed.id}: ${String(error)}`,
      );
    }
  }

  private async readFeed(
    url: string,
    validators: ConditionalValidators | null,
  ): Promise<FeedRead> {
    const fetched = await this.fetcher.fetchFeed(url, validators);
    if (fetched.notModified) return { notModified: true };
    try {
      return {
        notModified: false,
        parsed: parsePodcastFeed(fetched.xml),
        finalUrl: fetched.finalUrl,
        etag: fetched.etag,
        lastModified: fetched.lastModified,
      };
    } catch (error) {
      if (error instanceof NotAFeedError) {
        throw new FeedFetchError('not_a_feed');
      }
      throw error;
    }
  }

  /** `readFeed` for a request path: a feed that cannot be read is a 422
   *  carrying its `FeedErrorCode`. */
  private async readFeedOrThrow(url: string): Promise<FeedRead> {
    try {
      return await this.readFeed(url, null);
    } catch (error) {
      if (error instanceof FeedFetchError) {
        throw new UnprocessableEntityException({
          code: error.code,
          message: 'That feed could not be read.',
        });
      }
      throw error;
    }
  }

  private normalizeOrThrow(rawUrl: string): string {
    const url = normalizeFeedUrl(rawUrl);
    if (!url) {
      throw new BadRequestException('url must be an http(s) feed URL');
    }
    return url;
  }

  /** The section episodes may publish into: one the persona's kind has, and
   *  never `links` (retired) or `gallery` (a photo strip). */
  private assertImportSection(
    persona: Subprofile,
    section: string,
  ): SubprofileSection {
    const known = Object.values(SubprofileSection).includes(
      section as SubprofileSection,
    );
    const candidate = section as SubprofileSection;
    if (
      !known ||
      candidate === SubprofileSection.Links ||
      candidate === SubprofileSection.Gallery ||
      !isSectionAllowed(persona.kind, candidate)
    ) {
      throw new BadRequestException(
        `Section "${section}" cannot receive imported episodes for kind "${persona.kind}"`,
      );
    }
    return candidate;
  }

  private async assertUnderFeedLimit(
    manager: EntityManager,
    subprofileId: string,
  ): Promise<void> {
    const count = await manager.count(SubprofileFeed, {
      where: { subprofileId },
    });
    if (count >= MAX_FEEDS_PER_SUBPROFILE) {
      throw new UnprocessableEntityException({
        code: FEED_LIMIT_CODE,
        message: `A persona can connect at most ${MAX_FEEDS_PER_SUBPROFILE} feeds`,
      });
    }
  }

  private async assertNotConnected(
    subprofileId: string,
    urls: string[],
  ): Promise<void> {
    const exists = await this.feeds.exists({
      where: { subprofileId, feedUrl: In(urls) },
    });
    if (exists) throw this.alreadyConnected();
  }

  private alreadyConnected(): ConflictException {
    return new ConflictException({
      code: FEED_ALREADY_CONNECTED_CODE,
      message: 'This feed is already connected to this persona.',
    });
  }

  private async findFeed(
    subprofileId: string,
    feedId: string,
  ): Promise<SubprofileFeed> {
    const feed = await this.feeds.findOne({
      where: { id: feedId, subprofileId },
    });
    if (!feed) throw new NotFoundException('Feed not found');
    return feed;
  }

  private async getFeedDTO(
    subprofileId: string,
    feedId: string,
  ): Promise<SubprofileFeedDTO> {
    const feed = await this.findFeed(subprofileId, feedId);
    const [dto] = await this.toFeedDTOs([feed]);
    return dto!;
  }

  /** Feed DTOs with their pending/published counts, in one grouped query. */
  private async toFeedDTOs(
    feeds: SubprofileFeed[],
  ): Promise<SubprofileFeedDTO[]> {
    if (!feeds.length) return [];
    const rows = await this.entries
      .createQueryBuilder('entry')
      .select('entry.feedId', 'feedId')
      .addSelect('entry.status', 'status')
      .addSelect('COUNT(*)::int', 'count')
      .where('entry.feedId IN (:...feedIds)', {
        feedIds: feeds.map((feed) => feed.id),
      })
      .andWhere('entry.status IN (:...statuses)', {
        statuses: ['pending', 'published'],
      })
      .groupBy('entry.feedId')
      .addGroupBy('entry.status')
      .getRawMany<{ feedId: string; status: string; count: number | string }>();
    const countsByFeed = new Map<string, FeedEntryCounts>();
    for (const row of rows) {
      const counts = countsByFeed.get(row.feedId) ?? {
        pending: 0,
        published: 0,
      };
      if (row.status === 'pending') counts.pending = Number(row.count);
      if (row.status === 'published') counts.published = Number(row.count);
      countsByFeed.set(row.feedId, counts);
    }
    return feeds.map((feed) =>
      toFeedDTO(
        feed,
        countsByFeed.get(feed.id) ?? { pending: 0, published: 0 },
      ),
    );
  }
}
