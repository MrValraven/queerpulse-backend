import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { CursorPage } from '../common/cursor-pagination';
import { MemberLookup } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import type { PlatformLogEntryDTO } from './dto/platform-log-entry.dto';
import type { PlatformLogQuery } from './dto/platform-log-query.dto';
import {
  compareNewestFirst,
  decodePlatformLogCursor,
  encodePlatformLogCursor,
} from './platform-log-cursor';
import {
  toPlatformLogEntryDto,
  userIdsToResolve,
} from './platform-log-parties';
import { sinceForRange } from './platform-log-query';
import {
  PLATFORM_LOG_CATEGORIES,
  PLATFORM_LOG_SOURCES,
  type PlatformLogCategory,
  type PlatformLogSource,
  type SourceWindow,
} from './platform-log.types';

export const PLATFORM_LOG_DEFAULT_LIMIT = 30;
export const PLATFORM_LOG_MAX_LIMIT = 50;

export interface PlatformLogViewer {
  role: string;
}

@Injectable()
export class PlatformLogService {
  constructor(
    @Inject(PLATFORM_LOG_SOURCES) private readonly sources: PlatformLogSource[],
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
  ) {}

  /**
   * One page of the merged log. A moderator never reaches an `admin` source,
   * never gets the members category, and gets Reviews with member-initiated
   * rows removed in SQL, whatever the request asked for.
   */
  async list(
    query: PlatformLogQuery,
    viewer: PlatformLogViewer,
    now: Date = new Date(),
  ): Promise<CursorPage<PlatformLogEntryDTO>> {
    const isAdmin = viewer.role === (UserRole.Admin as string);
    const limit = Math.min(
      query.limit ?? PLATFORM_LOG_DEFAULT_LIMIT,
      PLATFORM_LOG_MAX_LIMIT,
    );
    const requested: readonly PlatformLogCategory[] = query.categories?.length
      ? query.categories
      : PLATFORM_LOG_CATEGORIES;
    const categories = requested.filter(
      (category) => isAdmin || category !== 'members',
    );
    if (categories.length === 0) {
      return { data: [], pageInfo: { nextCursor: null, hasMore: false } };
    }

    const window: SourceWindow = {
      cursor: decodePlatformLogCursor(query.cursor),
      since: sinceForRange(query.range ?? 'all', now),
      limit,
      memberId: query.memberId ?? null,
      staffRowsOnly: !isAdmin,
      categories,
    };
    const selectedSources = this.sources.filter(
      (source) =>
        (isAdmin || source.audience === 'staff') &&
        source.categories.some((category) => categories.includes(category)),
    );
    const batches = await Promise.all(
      selectedSources.map((source) => source.fetch(window)),
    );
    const merged = batches.flat().sort(compareNewestFirst);
    const pageEntries = merged.slice(0, limit);
    const hasMore = merged.length > limit;
    const lastEntry = pageEntries[pageEntries.length - 1];
    const names = await new MemberLookup(this.profiles).byUserIds(
      userIdsToResolve(pageEntries),
    );

    return {
      data: pageEntries.map((entry) => toPlatformLogEntryDto(entry, names)),
      pageInfo: {
        nextCursor:
          hasMore && lastEntry ? encodePlatformLogCursor(lastEntry) : null,
        hasMore,
      },
    };
  }
}
