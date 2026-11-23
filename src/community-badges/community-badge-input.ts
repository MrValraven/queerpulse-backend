import { isUUID } from 'class-validator';
import { toStoredPlainTextOrNull } from '../communities/community-plain-text';
import { sanitizeMessageBody } from '../messaging/dto/trim-message-body';
import {
  COMMUNITY_BADGE_NAME_MAX_LENGTH,
  COMMUNITY_BADGE_RULES,
  COMMUNITY_GIFT_NOTE_MAX_LENGTH,
  CommunityBadgeIconKey,
  CommunityBadgeRuleType,
  CommunityFlairTint,
  CommunityGiftKey,
  codePointLength,
  isCommunityBadgeIconKey,
  isCommunityBadgeRuleType,
  isCommunityFlairTint,
  isCommunityGiftKey,
} from './community-badges.catalog';
import { communityBadgeError } from './community-badges.constants';
import type {
  CreateCommunityBadgeDto,
  SendCommunityGiftDto,
  UpdateCommunityBadgeDto,
} from './dto/community-badges.dto';

/** A create body after every field passed its check. */
export interface NormalizedBadgeCreate {
  name: string;
  iconKey: CommunityBadgeIconKey;
  tint: CommunityFlairTint;
  ruleType: CommunityBadgeRuleType;
  threshold: number;
  isEnabled: boolean;
}

/** An update body after the keys it carries passed their checks. A key the
 *  body left out is absent here. */
export type NormalizedBadgeUpdate = Partial<
  Pick<
    NormalizedBadgeCreate,
    'name' | 'iconKey' | 'tint' | 'threshold' | 'isEnabled'
  >
>;

/** A gift send body after every field passed its check. */
export interface NormalizedGiftSend {
  recipientSlug: string;
  giftKey: CommunityGiftKey;
  note: string | null;
}

/** Whether a value is a uuid string. */
export function isCommunityBadgeUuid(value: unknown): value is string {
  return typeof value === 'string' && isUUID(value);
}

/** A badge name as stored: markup stripped, trimmed. Answers
 *  `badge_name_required` for a non-string or an empty result and
 *  `badge_name_too_long` past 32 code points. */
export function normalizeBadgeName(value: unknown): string {
  if (typeof value !== 'string')
    throw communityBadgeError('badge_name_required');
  const stored = toStoredPlainTextOrNull(value)?.trim() ?? '';
  if (!stored.length) throw communityBadgeError('badge_name_required');
  if (codePointLength(stored) > COMMUNITY_BADGE_NAME_MAX_LENGTH) {
    throw communityBadgeError('badge_name_too_long', {
      maxLength: COMMUNITY_BADGE_NAME_MAX_LENGTH,
    });
  }
  return stored;
}

/** A threshold that is a whole number inside the range of its rule. Answers
 *  `badge_threshold_out_of_range` with the rule and its range otherwise. */
export function normalizeBadgeThreshold(
  value: unknown,
  ruleType: CommunityBadgeRuleType,
): number {
  const { min, max } = COMMUNITY_BADGE_RULES[ruleType];
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw communityBadgeError('badge_threshold_out_of_range', {
      ruleType,
      min,
      max,
    });
  }
  return value;
}

function normalizeBadgeIconKey(value: unknown): CommunityBadgeIconKey {
  if (!isCommunityBadgeIconKey(value))
    throw communityBadgeError('badge_icon_unknown');
  return value;
}

function normalizeBadgeTint(value: unknown): CommunityFlairTint {
  if (!isCommunityFlairTint(value))
    throw communityBadgeError('badge_tint_unknown');
  return value;
}

function normalizeBadgeEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean')
    throw communityBadgeError('badge_enabled_invalid');
  return value;
}

/** Checks a create body. The first failure wins, in the order name, iconKey,
 *  tint, ruleType, threshold, isEnabled. An absent `isEnabled` reads true. */
export function normalizeBadgeCreate(
  body: CreateCommunityBadgeDto,
): NormalizedBadgeCreate {
  const name = normalizeBadgeName(body.name);
  const iconKey = normalizeBadgeIconKey(body.iconKey);
  const tint = normalizeBadgeTint(body.tint);
  if (!isCommunityBadgeRuleType(body.ruleType)) {
    throw communityBadgeError('badge_rule_unknown');
  }
  const ruleType = body.ruleType;
  const threshold = normalizeBadgeThreshold(body.threshold, ruleType);
  const isEnabled =
    body.isEnabled === undefined ? true : normalizeBadgeEnabled(body.isEnabled);
  return { name, iconKey, tint, ruleType, threshold, isEnabled };
}

/** Checks an update body against the rule the badge already stores. Only keys
 *  present on the body (not `undefined`) are checked and returned, in the
 *  order name, iconKey, tint, ruleType, threshold, isEnabled. A body that
 *  carries `ruleType` with any value answers `badge_rule_locked` at that slot. */
export function normalizeBadgeUpdate(
  body: UpdateCommunityBadgeDto,
  storedRuleType: CommunityBadgeRuleType,
): NormalizedBadgeUpdate {
  const update: NormalizedBadgeUpdate = {};
  if (body.name !== undefined) update.name = normalizeBadgeName(body.name);
  if (body.iconKey !== undefined)
    update.iconKey = normalizeBadgeIconKey(body.iconKey);
  if (body.tint !== undefined) update.tint = normalizeBadgeTint(body.tint);
  if (body.ruleType !== undefined)
    throw communityBadgeError('badge_rule_locked');
  if (body.threshold !== undefined) {
    update.threshold = normalizeBadgeThreshold(body.threshold, storedRuleType);
  }
  if (body.isEnabled !== undefined) {
    update.isEnabled = normalizeBadgeEnabled(body.isEnabled);
  }
  return update;
}

/** The badge id of a flair change: null stops wearing, a uuid string returns
 *  lowercased, and anything else (an absent value included) answers
 *  `flair_badge_id_invalid`. */
export function normalizeFlairBadgeId(value: unknown): string | null {
  if (value === null) return null;
  if (!isCommunityBadgeUuid(value))
    throw communityBadgeError('flair_badge_id_invalid');
  return value.toLowerCase();
}

function normalizeGiftNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw communityBadgeError('gift_note_invalid');
  const note = sanitizeMessageBody(value).trim();
  if (!note.length) return null;
  if (codePointLength(note) > COMMUNITY_GIFT_NOTE_MAX_LENGTH) {
    throw communityBadgeError('gift_note_too_long', {
      maxLength: COMMUNITY_GIFT_NOTE_MAX_LENGTH,
    });
  }
  return note;
}

/** Checks a gift send body. The first failure wins, in the order
 *  recipientSlug, giftKey, note. Membership and self checks belong to the
 *  service, which runs them after this. */
export function normalizeGiftSend(
  body: SendCommunityGiftDto,
): NormalizedGiftSend {
  const recipientSlug =
    typeof body.recipientSlug === 'string' ? body.recipientSlug.trim() : '';
  if (!recipientSlug.length)
    throw communityBadgeError('gift_recipient_not_member');
  if (!isCommunityGiftKey(body.giftKey))
    throw communityBadgeError('gift_unknown');
  const note = normalizeGiftNote(body.note);
  return { recipientSlug, giftKey: body.giftKey, note };
}

/** The `isHidden` flag of a gift update: a boolean, or `gift_hidden_invalid`. */
export function normalizeGiftHidden(value: unknown): boolean {
  if (typeof value !== 'boolean')
    throw communityBadgeError('gift_hidden_invalid');
  return value;
}
