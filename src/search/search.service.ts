import { Injectable } from '@nestjs/common';
import { ProfilesService } from '../profiles/profiles.service';
import { DirectoryService } from '../listings/directory.service';
import { CommunitiesService } from '../communities/communities.service';
import { EventsService } from '../events/events.service';
import { ForumThreadsService } from '../forum/forum-threads.service';
import { SearchResultType } from './dto/search.query';
import {
  SearchResponseDTO,
  SearchResultDTO,
  memberToResult,
  communityToResult,
  eventToResult,
  forumToResult,
  businessToResult,
} from './search-response';

const PER_TYPE_LIMIT = 6;
const DEFAULT_TOTAL_LIMIT = 30;
// Fixed display order; the frontend groups by type anyway.
const TYPE_ORDER: SearchResultType[] = [
  SearchResultType.Member,
  SearchResultType.Community,
  SearchResultType.Event,
  SearchResultType.Forum,
  SearchResultType.Business,
];

@Injectable()
export class SearchService {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly directory: DirectoryService,
    private readonly communities: CommunitiesService,
    private readonly events: EventsService,
    private readonly forumThreads: ForumThreadsService,
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

    const [members, communities, events, forum, businesses] = await Promise.all(
      [
        wants(SearchResultType.Member)
          ? this.profiles
              .searchMembers({ query }, viewerUserId)
              .then((page) =>
                page.items.slice(0, PER_TYPE_LIMIT).map(memberToResult),
              )
          : Promise.resolve<SearchResultDTO[]>([]),
        wants(SearchResultType.Community)
          ? this.communities
              .searchByText(viewerUserId, query, PER_TYPE_LIMIT)
              .then((rows) => rows.map(communityToResult))
          : Promise.resolve<SearchResultDTO[]>([]),
        wants(SearchResultType.Event)
          ? this.events
              .searchByText(viewerUserId, query, PER_TYPE_LIMIT)
              .then((rows) => rows.map(eventToResult))
          : Promise.resolve<SearchResultDTO[]>([]),
        wants(SearchResultType.Forum)
          ? this.forumThreads
              .searchByText(viewerUserId, query, PER_TYPE_LIMIT)
              .then((rows) => rows.map(forumToResult))
          : Promise.resolve<SearchResultDTO[]>([]),
        wants(SearchResultType.Business)
          ? this.directory
              .listDirectory({ q: query })
              .then((rows) =>
                rows.slice(0, PER_TYPE_LIMIT).map(businessToResult),
              )
          : Promise.resolve<SearchResultDTO[]>([]),
      ],
    );

    const byType: Record<SearchResultType, SearchResultDTO[]> = {
      [SearchResultType.Member]: members,
      [SearchResultType.Community]: communities,
      [SearchResultType.Event]: events,
      [SearchResultType.Forum]: forum,
      [SearchResultType.Business]: businesses,
    };
    const results = TYPE_ORDER.flatMap(
      (resultType) => byType[resultType],
    ).slice(0, totalLimit);
    return { query, results };
  }
}
