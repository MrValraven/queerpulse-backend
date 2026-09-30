import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import {
  foldedHaystack,
  foldedTextExpression,
  PROFILE_NAME_SEARCH_COLUMNS,
} from '../search/search-text';
import { Profile } from '../users/entities/profile.entity';
import {
  OFFICIAL_RECIPIENT_SEARCH_LIMIT,
  OFFICIAL_RECIPIENT_SEARCH_MIN_LENGTH,
} from './official-messages.constants';
import {
  OfficialRecipientResponse,
  OfficialRecipientRow,
  toOfficialRecipientResponse,
} from './official-messages-response';

// Name and handle as ONE folded haystack, compared against the folded `$1`
// pattern. `$1` stays a bound parameter: only the placeholder is wrapped.
const RECIPIENT_SEARCH_MATCH =
  `${foldedHaystack('profile', PROFILE_NAME_SEARCH_COLUMNS)} ` +
  `LIKE ${foldedTextExpression('$1')} ESCAPE '\\'`;

/**
 * The "message one member" picker. Mirrors `AdminTrustNetworkService.
 * searchMembers` (a match over first name, last name and handle, same
 * minimum length), but answers with the member's `userId`, which the post
 * route needs and the trust-network search does not return, and leaves out
 * system accounts, which have no official thread.
 *
 * `photo_visible` rides along because the row is mapped through
 * `toVisibleAvatarUrl`, the same "Show your photo" gate every other messaging
 * read path applies. A member who has hidden their face has hidden it here
 * too; an admin picker is not an exemption.
 *
 * The match is accent-folded on both sides (`RECIPIENT_SEARCH_MATCH`), so an
 * admin typing "joao" finds "João".
 */
@Injectable()
export class OfficialRecipientsService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
  ) {}

  async search(term: string | undefined): Promise<OfficialRecipientResponse[]> {
    const trimmed = (term ?? '').trim();
    if (trimmed.length < OFFICIAL_RECIPIENT_SEARCH_MIN_LENGTH) return [];
    const pattern = `%${escapeLikeTerm(trimmed)}%`;
    const rows: OfficialRecipientRow[] = await this.profiles.query(
      `SELECT profile.user_id, profile.slug, profile.first_name, profile.last_name,
              profile.avatar_url, profile.photo_visible, member.status
       FROM "profiles" profile
       JOIN "users" member ON member.id = profile.user_id
       WHERE member.is_system = false
         AND ${RECIPIENT_SEARCH_MATCH}
       ORDER BY profile.first_name ASC, profile.last_name ASC
       LIMIT $2`,
      [pattern, OFFICIAL_RECIPIENT_SEARCH_LIMIT],
    );
    return rows.map(toOfficialRecipientResponse);
  }
}
