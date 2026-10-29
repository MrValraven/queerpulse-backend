import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { normalizePage, PAGE_SIZE } from '../common/pagination';
import { toOrganizerView } from '../events/event-response';
import { houseMusicEventError } from '../events/house-music-event-errors';
import { STUDIO_ARTIST_PERSONA_KINDS } from '../studio/studio.constants';
import { Profile } from '../users/entities/profile.entity';
import type {
  StudioArtistCandidate,
  StudioArtistPersonaRef,
  StudioArtistSearchPage,
} from './admin-music-events-response';
import {
  STUDIO_ARTIST_BOOKABLE_SQL,
  STUDIO_ARTIST_PERSONAS_SQL,
  STUDIO_ARTIST_SEARCH_COUNT_SQL,
  STUDIO_ARTIST_SEARCH_SQL,
} from './studio-artist-sql';

interface StudioArtistIdRow {
  user_id: string;
}

interface StudioArtistCountRow {
  total: number;
}

interface StudioArtistPersonaRow {
  id: string;
  user_id: string;
  handle: string;
  display_name: string;
  kind: string;
}

interface StudioArtistBookableRow {
  is_studio_artist: boolean;
  is_blocked: boolean;
}

/** The trimmed query as a contains pattern with its LIKE wildcards escaped;
 *  the SQL folds it like the haystack. An empty query lists everyone. */
function likeTermFor(query: string | undefined): string | null {
  const trimmedQuery = query?.trim() ?? '';
  return trimmedQuery ? `%${escapeLikeTerm(trimmedQuery)}%` : null;
}

/**
 * The lineup picker and the book check for events QueerPulse hosts in Music
 * (contract route 1 and route 8). Both read the one Studio artist rule in
 * `studio-artist-sql.ts`: an active member who created a linked, listenable
 * persona of a Studio artist kind, with no block either way with the staff
 * member. The staff member's own connections play no part.
 */
@Injectable()
export class StudioArtistSearchService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
  ) {}

  async search(
    staffUserId: string,
    query: string | undefined,
    page: number | undefined,
  ): Promise<StudioArtistSearchPage> {
    const currentPage = normalizePage(page);
    const likeTerm = likeTermFor(query);
    const artistKinds = [...STUDIO_ARTIST_PERSONA_KINDS];
    const [idRows, countRows] = await Promise.all([
      this.dataSource.query<StudioArtistIdRow[]>(STUDIO_ARTIST_SEARCH_SQL, [
        likeTerm,
        staffUserId,
        artistKinds,
        PAGE_SIZE,
        (currentPage - 1) * PAGE_SIZE,
      ]),
      this.dataSource.query<StudioArtistCountRow[]>(
        STUDIO_ARTIST_SEARCH_COUNT_SQL,
        [likeTerm, staffUserId, artistKinds],
      ),
    ]);
    const total = countRows[0]?.total ?? 0;
    const memberIds = idRows.map((row) => row.user_id);
    if (memberIds.length === 0) {
      return { items: [], total, page: currentPage, pageSize: PAGE_SIZE };
    }

    const [profiles, personaRows] = await Promise.all([
      this.profiles.find({ where: { userId: In(memberIds) } }),
      this.dataSource.query<StudioArtistPersonaRow[]>(
        STUDIO_ARTIST_PERSONAS_SQL,
        [memberIds, artistKinds],
      ),
    ]);
    const profileByUserId = new Map(
      profiles.map((profile) => [profile.userId, profile]),
    );
    const personasByUserId = new Map<string, StudioArtistPersonaRef[]>();
    for (const personaRow of personaRows) {
      const memberPersonas = personasByUserId.get(personaRow.user_id) ?? [];
      memberPersonas.push({
        subprofileId: personaRow.id,
        handle: personaRow.handle,
        displayName: personaRow.display_name,
        kind: personaRow.kind,
      });
      personasByUserId.set(personaRow.user_id, memberPersonas);
    }

    // Kept in SQL order; a member whose profile vanished between the two
    // reads drops out of the page.
    const items: StudioArtistCandidate[] = [];
    for (const memberId of memberIds) {
      const organizerView = toOrganizerView(profileByUserId.get(memberId));
      if (!organizerView) continue;
      items.push({
        ...organizerView,
        artistPersonas: personasByUserId.get(memberId) ?? [],
      });
    }
    return { items, total, page: currentPage, pageSize: PAGE_SIZE };
  }

  /**
   * Refuses a performer who fails the search's Studio artist rule. A block
   * either way with the staff member answers the same code on purpose, so
   * the refusal never reveals a block.
   */
  async assertBookable(
    staffUserId: string,
    performerUserId: string,
  ): Promise<void> {
    const rows = await this.dataSource.query<StudioArtistBookableRow[]>(
      STUDIO_ARTIST_BOOKABLE_SQL,
      [performerUserId, staffUserId, [...STUDIO_ARTIST_PERSONA_KINDS]],
    );
    const bookableRow = rows[0];
    if (!bookableRow?.is_studio_artist || bookableRow.is_blocked) {
      throw houseMusicEventError('music_event_performer_not_studio_artist');
    }
  }
}
