import { ApiPropertyOptional } from '@nestjs/swagger';
import { Allow } from 'class-validator';
import { COMMUNITY_BADGE_ICON_KEYS } from '../../community-badges/community-badges.catalog';
import {
  QUIZ_BADGE_RARITIES,
  QUIZ_BADGE_TINTS,
} from '../quiz-win-badges.contract';

// Every field below is `@Allow()` and typed `unknown`: the decorator keeps the
// property through `whitelist` and validates nothing, so the normalisers in the
// quiz badge services own each check and a bad value always answers its own
// reason code. A property no class declares still gets the global
// `forbidNonWhitelisted` 400.

/** Body of `POST /admin/quizshow/badges` and `PATCH /admin/quizshow/badges/:id`
 *  (a PATCH applies any subset; a `name` or `description` object replaces both
 *  languages). The service answers, first failure wins: `quiz_badge_text_invalid`,
 *  `quiz_badge_name_required`, `quiz_badge_name_too_long`,
 *  `quiz_badge_description_required`, `quiz_badge_description_too_long`,
 *  `quiz_badge_icon_unknown`, `quiz_badge_tint_unknown`,
 *  `quiz_badge_rarity_unknown`, `quiz_badge_name_taken`. */
export class QuizBadgeDefinitionInputDto {
  @ApiPropertyOptional({
    description:
      'Object { en, pt }. en is required on create and at most 40 characters; pt is optional text or null. A bad value answers quiz_badge_text_invalid, quiz_badge_name_required or quiz_badge_name_too_long.',
    type: Object,
  })
  @Allow()
  name?: unknown;

  @ApiPropertyOptional({
    description:
      'Object { en, pt }. en is required on create and at most 140 characters; pt is optional text or null. A bad value answers quiz_badge_text_invalid, quiz_badge_description_required or quiz_badge_description_too_long.',
    type: Object,
  })
  @Allow()
  description?: unknown;

  @ApiPropertyOptional({
    description:
      'Required on create. One of the badge icon keys; anything else answers quiz_badge_icon_unknown.',
    enum: [...COMMUNITY_BADGE_ICON_KEYS],
  })
  @Allow()
  iconKey?: unknown;

  @ApiPropertyOptional({
    description:
      'Required on create. One of the badge tints; anything else answers quiz_badge_tint_unknown.',
    enum: [...QUIZ_BADGE_TINTS],
  })
  @Allow()
  tint?: unknown;

  @ApiPropertyOptional({
    description:
      'Required on create. One of the badge rarities; anything else answers quiz_badge_rarity_unknown.',
    enum: [...QUIZ_BADGE_RARITIES],
  })
  @Allow()
  rarity?: unknown;
}

/** Body of `PUT /admin/quizshow/events/:eventId/badges`. The service answers,
 *  first failure wins: `quiz_badge_setup_invalid`,
 *  `quiz_badge_game_number_invalid`, `quiz_badge_game_limit_reached`,
 *  `quiz_badge_slot_limit_reached`, `quiz_badge_slot_duplicate`,
 *  `quiz_badge_not_found`, `quiz_badge_archived`. */
export class QuizEventBadgeSetupInputDto {
  @ApiPropertyOptional({
    description:
      'Array of { gameNumber, badgeDefinitionIds }. An array in any other shape answers quiz_badge_setup_invalid.',
    type: [Object],
  })
  @Allow()
  games?: unknown;
}

/** Body of `POST /admin/quizshow/events/:eventId/winners/:winnerId/revoke`.
 *  The service answers, first failure wins:
 *  `quiz_badge_revoke_reason_required`, `quiz_badge_revoke_reason_too_long`. */
export class QuizGameWinRevokeInputDto {
  @ApiPropertyOptional({
    description:
      'Required. Text of at most 300 characters after trimming; the moderation log keeps it with the revoke.',
    type: String,
  })
  @Allow()
  reason?: unknown;
}
