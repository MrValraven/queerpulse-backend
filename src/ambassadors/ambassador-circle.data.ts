import type { CreateCommunityInput } from '../communities/communities.service';
import {
  AccessTier,
  CommunityType,
} from '../communities/entities/community.entity';
import type { UpsertCardProgramDto } from '../membership-cards/dto/upsert-card-program.dto';
import { CardSkin } from '../membership-cards/entities/community-card.entity';

/**
 * The circle as `CommunitiesService.create` founds it. Stored data in the
 * community row itself, so these strings live here and carry no i18n keys.
 *
 * `private` keeps it out of discover and closes it to non-members. It opens
 * with no spaces (`allowsSubcommunities` defaults to false on the entity),
 * which `CommunitySystemMembershipService` relies on: its removal does not
 * cascade into spaces.
 */
export const CIRCLE_COMMUNITY_INPUT: CreateCommunityInput = {
  name: 'QueerPulse Ambassadors',
  handle: 'queerpulse-ambassadors',
  purpose:
    'A private circle for QueerPulse Ambassadors and the team: early previews, polls and feedback on where the platform goes next.',
  type: CommunityType.Activism,
  whoFor: 'QueerPulse Ambassadors and QueerPulse staff.',
  tagline: 'Where ambassadors and the team talk shop',
  accessTier: AccessTier.Private,
  rosterVisible: false,
  // Ids from `COMMUNITY_FEATURES`. Staff post previews and polls in the
  // discussion, and run feedback sessions as events.
  features: ['discussion', 'events'],
  rules: [],
};

/**
 * The circle's card programme. `accentToken` is `accent`, the token the coral
 * colour lives under (`ACCENT_TOKENS` in `upsert-card-program.dto.ts` has no
 * `coral` entry because there is no `--coral` design token).
 */
export const CIRCLE_CARD_PROGRAM: UpsertCardProgramDto = {
  isEnabled: true,
  skin: CardSkin.Coral,
  accentToken: 'accent',
  cardName: 'QueerPulse Ambassador',
  allowsPublicBadge: false,
};
