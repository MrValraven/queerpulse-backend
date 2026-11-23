import { ApiPropertyOptional } from '@nestjs/swagger';
import { Allow } from 'class-validator';
import {
  COMMUNITY_BADGE_ICON_KEYS,
  COMMUNITY_FLAIR_TINTS,
  COMMUNITY_GIFT_KEYS,
  CommunityBadgeRuleType,
} from '../community-badges.catalog';

// Every field below is `@Allow()` and typed `unknown`: the decorator keeps the
// property through `whitelist` and validates nothing, so the normalisers in
// `community-badge-input.ts` own each check and a bad value always answers its
// own reason code. A property no class declares still gets the global
// `forbidNonWhitelisted` 400.

/** Body of `POST /communities/:slug/badges`. The service answers, first
 *  failure wins: `badge_name_required`, `badge_name_too_long`,
 *  `badge_icon_unknown`, `badge_tint_unknown`, `badge_rule_unknown`,
 *  `badge_threshold_out_of_range`, `badge_enabled_invalid`. */
export class CreateCommunityBadgeDto {
  @ApiPropertyOptional({
    description:
      'Required. At most 32 characters after markup is stripped and the text is trimmed.',
    type: String,
  })
  @Allow()
  name?: unknown;

  @ApiPropertyOptional({
    description: 'Required. One of the badge icon keys.',
    enum: [...COMMUNITY_BADGE_ICON_KEYS],
  })
  @Allow()
  iconKey?: unknown;

  @ApiPropertyOptional({
    description: 'Required. One of the flair tints.',
    enum: [...COMMUNITY_FLAIR_TINTS],
  })
  @Allow()
  tint?: unknown;

  @ApiPropertyOptional({
    description: 'Required. The rule the badge counts. Fixed once created.',
    enum: Object.values(CommunityBadgeRuleType),
  })
  @Allow()
  ruleType?: unknown;

  @ApiPropertyOptional({
    description:
      'Required. A whole number inside the range the chosen rule allows.',
    type: Number,
  })
  @Allow()
  threshold?: unknown;

  @ApiPropertyOptional({
    description: 'Defaults to true. A boolean when present.',
    type: Boolean,
  })
  @Allow()
  isEnabled?: unknown;
}

/** Body of `PATCH /communities/:slug/badges/:badgeId`. Any subset of the
 *  fields applies. `ruleType` is declared so a body that carries it reaches
 *  the service and answers with its own reason code, `badge_rule_locked`. */
export class UpdateCommunityBadgeDto {
  @ApiPropertyOptional({
    description: 'At most 32 characters after markup is stripped.',
    type: String,
  })
  @Allow()
  name?: unknown;

  @ApiPropertyOptional({
    description: 'One of the badge icon keys.',
    enum: [...COMMUNITY_BADGE_ICON_KEYS],
  })
  @Allow()
  iconKey?: unknown;

  @ApiPropertyOptional({
    description: 'One of the flair tints.',
    enum: [...COMMUNITY_FLAIR_TINTS],
  })
  @Allow()
  tint?: unknown;

  @ApiPropertyOptional({
    description: 'Any value answers badge_rule_locked: the rule never changes.',
    type: String,
  })
  @Allow()
  ruleType?: unknown;

  @ApiPropertyOptional({
    description:
      'A whole number inside the range of the rule the badge was created with.',
    type: Number,
  })
  @Allow()
  threshold?: unknown;

  @ApiPropertyOptional({
    description: 'A boolean. False switches the badge off for the community.',
    type: Boolean,
  })
  @Allow()
  isEnabled?: unknown;
}

/** Body of `PUT /communities/:slug/flair`. The service answers
 *  `flair_badge_id_invalid` for anything but a badge id or null. */
export class SetCommunityFlairDto {
  @ApiPropertyOptional({
    description: 'The id of an earned badge to wear, or null to stop wearing.',
    type: String,
    nullable: true,
  })
  @Allow()
  badgeId?: unknown;
}

/** Body of `POST /communities/:slug/gifts`. The service answers, first
 *  failure wins: `gift_recipient_not_member`, `gift_unknown`,
 *  `gift_note_too_long`, `gift_note_invalid`, then its own membership checks. */
export class SendCommunityGiftDto {
  @ApiPropertyOptional({
    description: 'Required. The slug of a current member of the community.',
    type: String,
  })
  @Allow()
  recipientSlug?: unknown;

  @ApiPropertyOptional({
    description: 'Required. One of the gift keys.',
    enum: [...COMMUNITY_GIFT_KEYS],
  })
  @Allow()
  giftKey?: unknown;

  @ApiPropertyOptional({
    description:
      'At most 140 characters after trimming. Null or blank sends no note.',
    type: String,
    nullable: true,
  })
  @Allow()
  note?: unknown;
}

/** Body of `PATCH /communities/:slug/gifts/:giftId`. The service answers
 *  `gift_hidden_invalid` for a value that is no boolean. */
export class UpdateCommunityGiftDto {
  @ApiPropertyOptional({
    description: 'Required. True hides the gift mark from other members.',
    type: Boolean,
  })
  @Allow()
  isHidden?: unknown;
}

/** Query of `GET /communities/:slug/gifts/mine`. A missing or malformed
 *  `page` reads as the first page, so no rule can answer a generic 400. */
export class ListMyCommunityGiftsQuery {
  @ApiPropertyOptional({
    description: 'One-based page number. Defaults to 1.',
    type: String,
  })
  @Allow()
  page?: unknown;
}
