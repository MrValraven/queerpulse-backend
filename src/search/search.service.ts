import { Injectable } from '@nestjs/common';
import { ProfilesService } from '../profiles/profiles.service';
import { DirectoryService } from '../listings/directory.service';
import { CommunitiesService } from '../communities/communities.service';
import { EventsService } from '../events/events.service';
import { ForumThreadsService } from '../forum/forum-threads.service';
import { MagazineService } from '../magazine/magazine.service';
import { JobsService } from '../jobs/jobs.service';
import { HousingDirectoryService } from '../housing-listings/housing-directory.service';
import { ResourcesService } from '../resources/resources.service';
import { WorkshopsService } from '../workshops/workshops.service';
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
  businessToResult,
  magazineToResult,
  jobToResult,
  housingToResult,
  resourceToResult,
  workshopToResult,
  subprofileToResult,
  topicToResult,
} from './search-response';

const PER_TYPE_LIMIT = 6;
const DEFAULT_TOTAL_LIMIT = 30;
// One global-search request fans out into up to 12 independent per-type
// queries. Firing all of them via a single `Promise.all` queues the pool
// against itself: `DATABASE_POOL_MAX` defaults to 10 connections, so a
// 12-query search request alone can exhaust the pool, starving every other
// concurrent request on the same connection. Waves of at most this many
// concurrent queries keep one search request from claiming more than half
// the pool, while still running well ahead of doing all 12 sequentially.
const MAX_CONCURRENT_QUERIES = 5;
// Fixed display order; the frontend groups by type anyway.
const TYPE_ORDER: SearchResultType[] = [
  SearchResultType.Member,
  SearchResultType.Community,
  SearchResultType.Event,
  SearchResultType.Forum,
  SearchResultType.Business,
  SearchResultType.Magazine,
  SearchResultType.Job,
  SearchResultType.Housing,
  SearchResultType.Resource,
  SearchResultType.Workshop,
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
    private readonly magazine: MagazineService,
    private readonly jobs: JobsService,
    private readonly housing: HousingDirectoryService,
    private readonly resources: ResourcesService,
    private readonly workshops: WorkshopsService,
    private readonly subprofiles: SubprofilesService,
    private readonly topics: TopicsService,
  ) {}

  async search(
    viewerUserId: string,
    rawQuery: string,
    type: SearchResultType | undefined,
    limit: number | undefined,
  ): Promise<SearchResponseDTO> {
    const query = rawQuery.trim();
    const totalLimit = Math.min(limit ?? DEFAULT_TOTAL_LIMIT, 50);
    if (!query) return { query, results: [] };

    const wants = (candidate: SearchResultType) => !type || type === candidate;
    // `PER_TYPE_LIMIT` (6) keeps a broad, all-types query balanced across up
    // to 12 result groups. But it was applied even when the caller filtered
    // to a single `type` — so `?type=member&limit=50` still came back with
    // only 6 members, and the frontend's "see all in this category" affordance
    // had nothing more to fetch. When one type is requested, only one query
    // runs, so it can use the full `totalLimit` instead.
    const perTypeLimit = type ? totalLimit : PER_TYPE_LIMIT;

    // Each entry is a THUNK (not a started promise) so `runInWaves` controls
    // exactly when a query starts — building the array eagerly with started
    // promises would fire all 11 queries immediately regardless of batching.
    // The `= []` defaults satisfy `noUncheckedIndexedAccess` (destructuring a
    // plain array's element is `SearchResultDTO[] | undefined` otherwise);
    // they're unreachable in practice since `runInWaves` always returns
    // exactly one result per input thunk.
    const [
      members = [],
      communities = [],
      events = [],
      forum = [],
      businesses = [],
      magazine = [],
      jobs = [],
      housing = [],
      resources = [],
      workshops = [],
      subprofiles = [],
      topics = [],
    ] = await this.runInWaves<SearchResultDTO[]>(
      [
        () =>
          wants(SearchResultType.Member)
            ? this.profiles
                .searchMembers({ query }, viewerUserId)
                .then((page) =>
                  page.items.slice(0, perTypeLimit).map(memberToResult),
                )
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Community)
            ? this.communities
                .searchByText(viewerUserId, query, perTypeLimit)
                .then((rows) => rows.map(communityToResult))
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Event)
            ? this.events
                .searchByText(viewerUserId, query, perTypeLimit)
                .then((rows) => rows.map(eventToResult))
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Forum)
            ? this.forumThreads
                .searchByText(viewerUserId, query, perTypeLimit)
                .then((rows) => rows.map(forumToResult))
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Business)
            ? this.directory
                .listDirectory({ q: query })
                .then((rows) =>
                  rows.slice(0, perTypeLimit).map(businessToResult),
                )
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Magazine)
            ? this.magazine
                .searchByText(query, perTypeLimit)
                .then((rows) => rows.map(magazineToResult))
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Job)
            ? this.jobs
                .searchByText(query, perTypeLimit)
                .then((rows) => rows.map(jobToResult))
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Housing)
            ? this.housing
                .searchByText(query, perTypeLimit)
                .then((rows) => rows.map(housingToResult))
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Resource)
            ? this.resources
                .searchByText(query, perTypeLimit)
                .then((rows) => rows.map(resourceToResult))
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Workshop)
            ? this.workshops
                .searchByText(viewerUserId, query, perTypeLimit)
                .then((rows) => rows.map(workshopToResult))
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Subprofile)
            ? this.subprofiles
                .searchByText(viewerUserId, query, perTypeLimit)
                .then((rows) => rows.map(subprofileToResult))
            : Promise.resolve<SearchResultDTO[]>([]),
        () =>
          wants(SearchResultType.Topic)
            ? this.topics
                .searchByText(query, perTypeLimit)
                .then((rows) => rows.map(topicToResult))
            : Promise.resolve<SearchResultDTO[]>([]),
      ],
      MAX_CONCURRENT_QUERIES,
    );

    const byType: Record<SearchResultType, SearchResultDTO[]> = {
      [SearchResultType.Member]: members,
      [SearchResultType.Community]: communities,
      [SearchResultType.Event]: events,
      [SearchResultType.Forum]: forum,
      [SearchResultType.Business]: businesses,
      [SearchResultType.Magazine]: magazine,
      [SearchResultType.Job]: jobs,
      [SearchResultType.Housing]: housing,
      [SearchResultType.Resource]: resources,
      [SearchResultType.Workshop]: workshops,
      [SearchResultType.Subprofile]: subprofiles,
      [SearchResultType.Topic]: topics,
    };
    const results = TYPE_ORDER.flatMap(
      (resultType) => byType[resultType],
    ).slice(0, totalLimit);
    return { query, results };
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
