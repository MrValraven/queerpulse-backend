import { Injectable } from '@nestjs/common';
import { ProfilesService } from '../profiles/profiles.service';
import { DirectoryService } from '../listings/directory.service';
import { CommunitiesService } from '../communities/communities.service';
import { EventsService } from '../events/events.service';
import { ForumThreadsService } from '../forum/forum-threads.service';
import { ForumPostsService } from '../forum/forum-posts.service';
import { MagazineService } from '../magazine/magazine.service';
import { JobsService } from '../jobs/jobs.service';
import { HousingDirectoryService } from '../housing-listings/housing-directory.service';
import { ResourcesService } from '../resources/resources.service';
import { SubprofilesService } from '../subprofiles/subprofiles.service';
import { TopicsService } from '../content/topics.service';
import { SearchResultType } from './dto/search.query';
import {
  SearchResponseDTO,
  SearchResultDTO,
  memberToResult,
  communityToResult,
  eventToResult,
  forumToResult,
  forumPostToResult,
  businessToResult,
  magazineToResult,
  jobToResult,
  housingToResult,
  resourceToResult,
  subprofileToResult,
  topicToResult,
} from './search-response';

const PER_TYPE_LIMIT = 6;
const DEFAULT_TOTAL_LIMIT = 30;
// Hard ceiling on `?offset=`, mirroring `SearchQuery`'s validator. Types whose
// service takes no offset of its own pay for `offset + limit` rows and discard
// the head, so this bounds that waste.
const MAX_OFFSET = 200;
// One global-search request fans out into up to 12 independent per-type
// queries (reply bodies became the twelfth in SOC-08). Firing all of them via
// a single `Promise.all` queues the pool against itself: `DATABASE_POOL_MAX`
// defaults to 10 connections, so a 12-query search request alone can exhaust
// the pool, starving every other concurrent request on the same connection.
// Waves of at most this many concurrent queries keep one search request from
// claiming more than half the pool, while still running well ahead of doing
// all 12 sequentially.
const MAX_CONCURRENT_QUERIES = 5;
// Fixed display order; the frontend groups by type anyway.
const TYPE_ORDER: SearchResultType[] = [
  SearchResultType.Member,
  SearchResultType.Community,
  SearchResultType.Event,
  SearchResultType.Forum,
  SearchResultType.ForumPost,
  SearchResultType.Business,
  SearchResultType.Magazine,
  SearchResultType.Job,
  SearchResultType.Housing,
  SearchResultType.Resource,
  SearchResultType.Subprofile,
  SearchResultType.Topic,
];

@Injectable()
export class SearchService {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly directory: DirectoryService,
    private readonly communities: CommunitiesService,
    private readonly events: EventsService,
    private readonly forumThreads: ForumThreadsService,
    private readonly forumPosts: ForumPostsService,
    private readonly magazine: MagazineService,
    private readonly jobs: JobsService,
    private readonly housing: HousingDirectoryService,
    private readonly resources: ResourcesService,
    private readonly subprofiles: SubprofilesService,
    private readonly topics: TopicsService,
  ) {}

  async search(
    viewerUserId: string,
    rawQuery: string,
    type: SearchResultType | undefined,
    limit: number | undefined,
    rawOffset?: number,
  ): Promise<SearchResponseDTO> {
    const query = rawQuery.trim();
    const totalLimit = Math.min(limit ?? DEFAULT_TOTAL_LIMIT, 50);
    if (!query) return { query, results: [], hasMore: false };

    const wants = (candidate: SearchResultType) => !type || type === candidate;
    // `PER_TYPE_LIMIT` (6) keeps a broad, all-types query balanced across up
    // to 12 result groups. But it was applied even when the caller filtered
    // to a single `type` — so `?type=member&limit=50` still came back with
    // only 6 members, and the frontend's "see all in this category" affordance
    // had nothing more to fetch. When one type is requested, only one query
    // runs, so it can use the full `totalLimit` instead.
    const perTypeLimit = type ? totalLimit : PER_TYPE_LIMIT;
    // Offsetting is a single-type affair (SOC-08): the merged view groups by
    // type and offers a tab, so paging it would interleave incomparable ranks.
    const offset = type ? Math.min(rawOffset ?? 0, MAX_OFFSET) : 0;
    // One extra row, purely to answer "is there another page?" without a
    // second COUNT query. Trimmed off before the response is built.
    const probeLimit = type ? perTypeLimit + 1 : perTypeLimit;

    // Each entry is a THUNK (not a started promise) so `runInWaves` controls
    // exactly when a query starts — building the array eagerly with started
    // promises would fire all 12 queries immediately regardless of batching.
    // The `= []` defaults satisfy `noUncheckedIndexedAccess` (destructuring a
    // plain array's element is `SearchResultDTO[] | undefined` otherwise);
    // they're unreachable in practice since `runInWaves` always returns
    // exactly one result per input thunk.
    const [
      members = [],
      communities = [],
      events = [],
      forum = [],
      forumPosts = [],
      businesses = [],
      magazine = [],
      jobs = [],
      housing = [],
      resources = [],
      subprofiles = [],
      topics = [],
    ] = await this.runInWaves<SearchResultDTO[]>(
      [
        () =>
          wants(SearchResultType.Member)
            ? this.profiles
                .searchMembers({ query }, viewerUserId, {
                  offset,
                  limit: probeLimit,
                })
                .then((page) => page.items.map(memberToResult))
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Community)
            ? this.skipping(offset, probeLimit, (fetchLimit) =>
                this.communities
                  .searchByText(viewerUserId, query, fetchLimit)
                  .then((rows) => rows.map(communityToResult)),
              )
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Event)
            ? this.skipping(offset, probeLimit, (fetchLimit) =>
                this.events
                  .searchByText(viewerUserId, query, fetchLimit)
                  .then((rows) => rows.map(eventToResult)),
              )
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Forum)
            ? this.forumThreads
                .searchByText(viewerUserId, query, probeLimit, offset)
                .then((rows) => rows.map(forumToResult))
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.ForumPost)
            ? this.forumPosts
                .searchByText(viewerUserId, query, probeLimit, offset)
                .then((rows) => rows.map(forumPostToResult))
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Business)
            ? this.skipping(offset, probeLimit, (fetchLimit) =>
                this.directory
                  .listDirectory({ q: query })
                  .then((rows) =>
                    rows.slice(0, fetchLimit).map(businessToResult),
                  ),
              )
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Magazine)
            ? this.skipping(offset, probeLimit, (fetchLimit) =>
                this.magazine
                  .searchByText(query, fetchLimit)
                  .then((rows) => rows.map(magazineToResult)),
              )
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Job)
            ? this.skipping(offset, probeLimit, (fetchLimit) =>
                this.jobs
                  .searchByText(query, fetchLimit)
                  .then((rows) => rows.map(jobToResult)),
              )
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Housing)
            ? this.skipping(offset, probeLimit, (fetchLimit) =>
                this.housing
                  .searchByText(query, fetchLimit)
                  .then((rows) => rows.map(housingToResult)),
              )
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Resource)
            ? this.skipping(offset, probeLimit, (fetchLimit) =>
                this.resources
                  .searchByText(query, fetchLimit)
                  .then((rows) => rows.map(resourceToResult)),
              )
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Subprofile)
            ? this.skipping(offset, probeLimit, (fetchLimit) =>
                this.subprofiles
                  .searchByText(viewerUserId, query, fetchLimit)
                  .then((rows) => rows.map(subprofileToResult)),
              )
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Topic)
            ? this.skipping(offset, probeLimit, (fetchLimit) =>
                this.topics
                  .searchByText(query, fetchLimit)
                  .then((rows) => rows.map(topicToResult)),
              )
            : Promise.resolve<SearchResultDTO[]>([]),
      ],
      MAX_CONCURRENT_QUERIES,
    );

    const byType: Record<SearchResultType, SearchResultDTO[]> = {
      [SearchResultType.Member]: members,
      [SearchResultType.Community]: communities,
      [SearchResultType.Event]: events,
      [SearchResultType.Forum]: forum,
      [SearchResultType.ForumPost]: forumPosts,
      [SearchResultType.Business]: businesses,
      [SearchResultType.Magazine]: magazine,
      [SearchResultType.Job]: jobs,
      [SearchResultType.Housing]: housing,
      [SearchResultType.Resource]: resources,
      [SearchResultType.Subprofile]: subprofiles,
      [SearchResultType.Topic]: topics,
    };
    // Single-type: the probe row decides `hasMore` and is then dropped, so the
    // caller can render a "load more" without a second request or a count.
    if (type) {
      const bucket = byType[type];
      return {
        query,
        results: bucket.slice(0, perTypeLimit),
        hasMore: bucket.length > perTypeLimit,
      };
    }
    const results = TYPE_ORDER.flatMap(
      (resultType) => byType[resultType],
    ).slice(0, totalLimit);
    return { query, results, hasMore: false };
  }

  /**
   * Offset for the types whose `searchByText` takes only a limit. Asks for
   * `offset + limit` rows and throws the head away.
   *
   * Deliberately not pushed down into those services: each lives in a module
   * this one only consumes, and an over-fetch bounded by `MAX_OFFSET` (200)
   * costs a few hundred rows on the rare deep page, against changing ten
   * signatures. `member`, `forum` and `forumPost` — the three types that
   * actually get paged through — take a real offset instead.
   */
  private async skipping(
    offset: number,
    probeLimit: number,
    run: (fetchLimit: number) => Promise<SearchResultDTO[]>,
  ): Promise<SearchResultDTO[]> {
    if (!offset) return run(probeLimit);
    const rows = await run(offset + probeLimit);
    return rows.slice(offset);
  }

  /**
   * Runs `queryThunks` in sequential waves of at most `maxConcurrentQueries`
   * concurrent queries, preserving the input order in the returned array —
   * unlike a plain `Promise.all(queryThunks.map((thunk) => thunk()))`, which
   * starts every thunk in the same tick regardless of how many there are.
   * (Every call site here passes thunks that all resolve to the same
   * `SearchResultDTO[]` type, so a single type parameter — rather than a
   * tuple-preserving one — is all that's needed.)
   */
  private async runInWaves<QueryResult>(
    queryThunks: Array<() => Promise<QueryResult>>,
    maxConcurrentQueries: number,
  ): Promise<QueryResult[]> {
    const results: QueryResult[] = [];
    for (
      let waveStartIndex = 0;
      waveStartIndex < queryThunks.length;
      waveStartIndex += maxConcurrentQueries
    ) {
      const wave = queryThunks
        .slice(waveStartIndex, waveStartIndex + maxConcurrentQueries)
        .map((queryThunk) => queryThunk());
      results.push(...(await Promise.all(wave)));
    }
    return results;
  }
}
