import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { SUBCOMMUNITY_FEATURE_UNAVAILABLE_CODE } from '../communities/subcommunity-rules';
import { CommunityBadgeRuleType } from './community-badges.catalog';

/** Every reason code the badge, gift and flair routes answer with. */
export type CommunityBadgeRefusalCode =
  | 'badge_limit_reached'
  | 'badge_threshold_out_of_range'
  | 'badge_name_taken'
  | 'badge_name_required'
  | 'badge_name_too_long'
  | 'badge_icon_unknown'
  | 'badge_tint_unknown'
  | 'badge_rule_unknown'
  | 'badge_rule_locked'
  | 'badge_enabled_invalid'
  | 'badge_not_found'
  | 'badge_manage_owner_only'
  | 'badge_settings_staff_only'
  | 'gift_sender_not_staff'
  | 'gift_recipient_not_member'
  | 'gift_recipient_unavailable'
  | 'gift_to_self'
  | 'gift_weekly_limit_reached'
  | 'gift_unknown'
  | 'gift_note_too_long'
  | 'gift_note_invalid'
  | 'gift_not_found'
  | 'gift_remove_not_allowed'
  | 'gift_hidden_invalid'
  | 'flair_badge_id_invalid'
  | 'flair_badge_disabled'
  | 'flair_badge_not_earned';

/** The status and fixed message of each refusal code. */
export const COMMUNITY_BADGE_REFUSALS: Record<
  CommunityBadgeRefusalCode,
  { status: HttpStatus; message: string }
> = {
  badge_limit_reached: {
    status: HttpStatus.CONFLICT,
    message: 'A community can hold 12 badges, and this one has 12 already.',
  },
  badge_threshold_out_of_range: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'The threshold must be a whole number inside the range this rule allows.',
  },
  badge_name_taken: {
    status: HttpStatus.CONFLICT,
    message: 'Another badge in this community already uses that name.',
  },
  badge_name_required: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A badge needs a name.',
  },
  badge_name_too_long: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A badge name can be at most 32 characters.',
  },
  badge_icon_unknown: {
    status: HttpStatus.BAD_REQUEST,
    message: 'That icon is missing from the badge icon set.',
  },
  badge_tint_unknown: {
    status: HttpStatus.BAD_REQUEST,
    message: 'That colour is missing from the badge colour set.',
  },
  badge_rule_unknown: {
    status: HttpStatus.BAD_REQUEST,
    message: 'That rule is missing from the badge rules.',
  },
  badge_rule_locked: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'A badge keeps the rule it was created with. Create a new badge for a different rule.',
  },
  badge_enabled_invalid: {
    status: HttpStatus.BAD_REQUEST,
    message: 'isEnabled must be true or false.',
  },
  badge_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'Badge not found in this community.',
  },
  badge_manage_owner_only: {
    status: HttpStatus.FORBIDDEN,
    message: 'Only the community owner or a co-owner can change badges.',
  },
  badge_settings_staff_only: {
    status: HttpStatus.FORBIDDEN,
    message:
      'Only the community owner, a co-owner or a moderator can open the badge settings.',
  },
  gift_sender_not_staff: {
    status: HttpStatus.FORBIDDEN,
    message:
      'Only the community owner, a co-owner or a moderator can send gifts.',
  },
  gift_recipient_not_member: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Gifts can only go to a current member of this community.',
  },
  gift_recipient_unavailable: {
    status: HttpStatus.FORBIDDEN,
    message: 'This member cannot receive a gift from you.',
  },
  gift_to_self: {
    status: HttpStatus.BAD_REQUEST,
    message: 'You cannot send a gift to yourself.',
  },
  gift_weekly_limit_reached: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'You have sent 10 gifts in this community in the last 7 days.',
  },
  gift_unknown: {
    status: HttpStatus.BAD_REQUEST,
    message: 'That gift is missing from the gift catalogue.',
  },
  gift_note_too_long: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A gift note can be at most 140 characters.',
  },
  gift_note_invalid: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A gift note must be text or null.',
  },
  gift_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'Gift not found.',
  },
  gift_remove_not_allowed: {
    status: HttpStatus.FORBIDDEN,
    message:
      'Only the sender, the community owner or a co-owner can remove this gift.',
  },
  gift_hidden_invalid: {
    status: HttpStatus.BAD_REQUEST,
    message: 'isHidden must be true or false.',
  },
  flair_badge_id_invalid: {
    status: HttpStatus.BAD_REQUEST,
    message: 'badgeId must be a badge id or null.',
  },
  flair_badge_disabled: {
    status: HttpStatus.BAD_REQUEST,
    message: 'That badge is switched off in this community.',
  },
  flair_badge_not_earned: {
    status: HttpStatus.BAD_REQUEST,
    message: 'You have yet to earn that badge.',
  },
};

/** The extra body fields a refusal can carry. */
export interface CommunityBadgeErrorExtras {
  limit?: number;
  ruleType?: CommunityBadgeRuleType;
  min?: number;
  max?: number;
  maxLength?: number;
  resetsAt?: string;
}

/** The extra body fields each code carries. `communityBadgeError` copies only
 *  these and only when the matching extra is defined. */
export const COMMUNITY_BADGE_REFUSAL_EXTRAS: Record<
  CommunityBadgeRefusalCode,
  readonly (keyof CommunityBadgeErrorExtras)[]
> = {
  badge_limit_reached: ['limit'],
  badge_threshold_out_of_range: ['ruleType', 'min', 'max'],
  badge_name_taken: [],
  badge_name_required: [],
  badge_name_too_long: ['maxLength'],
  badge_icon_unknown: [],
  badge_tint_unknown: [],
  badge_rule_unknown: [],
  badge_rule_locked: [],
  badge_enabled_invalid: [],
  badge_not_found: [],
  badge_manage_owner_only: [],
  badge_settings_staff_only: [],
  gift_sender_not_staff: [],
  gift_recipient_not_member: [],
  gift_recipient_unavailable: [],
  gift_to_self: [],
  gift_weekly_limit_reached: ['limit', 'resetsAt'],
  gift_unknown: [],
  gift_note_too_long: ['maxLength'],
  gift_note_invalid: [],
  gift_not_found: [],
  gift_remove_not_allowed: [],
  gift_hidden_invalid: [],
  flair_badge_id_invalid: [],
  flair_badge_disabled: [],
  flair_badge_not_earned: [],
};

/** The one way the badge, gift and flair routes refuse a request:
 *  `{ statusCode, message, code }` plus each extra listed for the code whose
 *  value is defined. The message is always the fixed sentence from the table. */
export function communityBadgeError(
  code: CommunityBadgeRefusalCode,
  extras?: CommunityBadgeErrorExtras,
): HttpException {
  const { status, message } = COMMUNITY_BADGE_REFUSALS[code];
  const body: Record<string, unknown> = { statusCode: status, message, code };
  for (const extra of COMMUNITY_BADGE_REFUSAL_EXTRAS[code]) {
    const value = extras?.[extra];
    if (value !== undefined) {
      body[extra] = value;
    }
  }
  return new HttpException(body, status);
}

/** The subject string shared by the report and takedown paths, so content
 *  moderation need not import the report entity. */
export const COMMUNITY_GIFT_SUBJECT_TYPE = 'community_gift';

/** The refusal a space answers on every badge, gift and flair route. */
export function spaceFeatureUnavailableError(): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    message: 'Spaces have no badges, gifts or flair',
    code: SUBCOMMUNITY_FEATURE_UNAVAILABLE_CODE,
  });
}
