import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsSeededOrAuthored } from './overview-entry-form.decorator';

/**
 * Every `*Key`/`icon`/`tint` catalog below is copied verbatim from
 * `governance-overview.seed.ts` — the fixed set of content keys that already
 * have EN+PT translations.
 *
 * PRD-265 CHANGED WHAT THESE CATALOGS MEAN, and the distinction matters.
 *
 * They used to be the whole vocabulary: a decision, a principle or a council
 * role had to be one of these, so the public decision log — the page this
 * platform presents as its accountability record — could not grow past the
 * four entries in the bundle. Logging the next real decision needed a code
 * change and a deploy, which meant the people who took the decision could not
 * log it.
 *
 * They are now the allowlist for the SEEDED FORM only: an entry that names a
 * `key` must name one of these, because a key outside them has no translation
 * and would render as a raw identifier on a public page (see
 * [[seed-backed-content-404s-in-prod]]). An entry with no key carries its own
 * EN and PT text instead ({@link AuthoredTextDto}) and needs no deploy. So the
 * `@IsIn` guards below are kept deliberately: dropping them would not make the
 * record growable (the authored form already does), it would only let an
 * editor mint an orphan key.
 *
 * `icon` and `tint` stay closed for the same reason — both are identifiers the
 * frontend maps to a react-icon and a colour pair, not prose.
 */
export const HEALTH_KEYS = [
  'activeMembers',
  'retention',
  'reportsFiled',
  'membersRemoved',
  'gatheringsHosted',
  'appealUpheld',
] as const;
export type HealthKey = (typeof HEALTH_KEYS)[number];

export const HEALTH_TREND_KEYS = [
  'upThisQuarter',
  'steady',
  'allResolved',
  'cocViolations',
  'upVsQ1',
  'ofFiled',
] as const;
export type HealthTrendKey = (typeof HEALTH_TREND_KEYS)[number];

export const MODERATION_STEP_KEYS = [
  'reportFiled',
  'review',
  'decision',
  'appeal',
] as const;
export type ModerationStepKey = (typeof MODERATION_STEP_KEYS)[number];

export const COUNCIL_ROLE_KEYS = [
  'psychologistChair',
  'lawyerLegalAdvisor',
  'housingActivist',
  'healthcareAdvocate',
] as const;
export type CouncilRoleKey = (typeof COUNCIL_ROLE_KEYS)[number];

export const COUNCIL_TINTS = ['jade', 'violet', 'plum'] as const;
export type CouncilTint = (typeof COUNCIL_TINTS)[number];

export const PRINCIPLE_KEYS = [
  'noSellingData',
  'visibilityChoice',
  'noAlgorithms',
  'communityVoice',
  'transparency',
  'accessNotConditional',
] as const;
export type PrincipleKey = (typeof PRINCIPLE_KEYS)[number];

export const PRINCIPLE_ICONS = [
  'lock',
  'eye',
  'slash',
  'message',
  'book',
  'accessible',
] as const;
export type PrincipleIcon = (typeof PRINCIPLE_ICONS)[number];

export const DECISION_KEYS = [
  'slidingScale',
  'forumLaunched',
  'visibilityDefaults',
  'languageToggle',
] as const;
export type DecisionKey = (typeof DECISION_KEYS)[number];

export class HealthStatEditDto {
  @IsIn(HEALTH_KEYS)
  key!: HealthKey;

  @IsString()
  @MaxLength(20)
  n!: string;

  @IsBoolean()
  up!: boolean;

  @IsIn(HEALTH_TREND_KEYS)
  trendKey!: HealthTrendKey;

  @IsOptional()
  @IsInt()
  @Min(0)
  trendCount?: number;
}

export class ModerationStepEditDto {
  @IsIn(MODERATION_STEP_KEYS)
  key!: ModerationStepKey;
}

/**
 * PRD-265. The EN and PT of one piece of prose an editor wrote (the two
 * classes below differ only in their length cap).
 *
 * BOTH LANGUAGES ARE REQUIRED. There is no key here to translate later, so an
 * entry saved in English alone would appear untranslated to every Portuguese
 * reader of a page that exists to be read by them — and the platform has no
 * back-channel that would ever go and fill the gap in. Asking for both at
 * authoring time is the only moment the second language can be got.
 *
 * There are two length caps rather than one because a decision's one-line lead
 * and its paragraph body are not the same kind of text. `@MinLength(1)` rejects
 * an empty string; text that is only markup survives it and is caught at the
 * write boundary, where `GovernanceOverviewService` sanitises and refuses what
 * strips to nothing.
 */

/** A decision's lead line, a principle's title, or a council role
 *  descriptor: one line, in both languages. */
export class ShortAuthoredTextDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  en!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  pt!: string;
}

/** A decision's body or a principle's explanation: a paragraph, in both
 *  languages. */
export class LongAuthoredTextDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  en!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  pt!: string;
}

/**
 * One advisory-council seat. `name`/`initials` are data; the role descriptor is
 * either the seeded `roleKey` or the authored `role`, never both (PRD-265).
 *
 * Note the exclusive-or here is spelled on `roleKey`, not `key`: this is the
 * one section whose seeded identifier is not called `key`, so the shared
 * decorator cannot be used and the pair of `@ValidateIf` guards below carry it.
 * They are exhaustive between them — the first forbids an authored role
 * alongside a key, the second requires one in its absence.
 */
export class CouncilSeatEditDto {
  @IsString()
  @MaxLength(80)
  name!: string;

  @IsString()
  @MaxLength(4)
  initials!: string;

  // Present only on a seeded seat, and only when no authored role is given.
  @ValidateIf((seat: CouncilSeatEditDto) => seat.roleKey !== undefined)
  @IsIn(COUNCIL_ROLE_KEYS)
  roleKey?: CouncilRoleKey;

  // Required exactly when there is no `roleKey`, and refused when there is.
  @ValidateIf((seat: CouncilSeatEditDto) => seat.roleKey === undefined)
  @IsDefined({ message: 'a seat carries either "roleKey" or "role"' })
  @ValidateNested()
  @Type(() => ShortAuthoredTextDto)
  role?: ShortAuthoredTextDto;

  @IsIn(COUNCIL_TINTS)
  tint!: CouncilTint;
}

export class PrincipleEditDto {
  @IsSeededOrAuthored(['title', 'text'])
  @IsOptional()
  @IsIn(PRINCIPLE_KEYS)
  key?: PrincipleKey;

  @ValidateIf((principle: PrincipleEditDto) => principle.key === undefined)
  @IsDefined()
  @ValidateNested()
  @Type(() => ShortAuthoredTextDto)
  title?: ShortAuthoredTextDto;

  @ValidateIf((principle: PrincipleEditDto) => principle.key === undefined)
  @IsDefined()
  @ValidateNested()
  @Type(() => LongAuthoredTextDto)
  text?: LongAuthoredTextDto;

  @IsIn(PRINCIPLE_ICONS)
  icon!: PrincipleIcon;
}

export class DecisionEditDto {
  @IsSeededOrAuthored(['lead', 'body'])
  @IsOptional()
  @IsIn(DECISION_KEYS)
  key?: DecisionKey;

  @ValidateIf((decision: DecisionEditDto) => decision.key === undefined)
  @IsDefined()
  @ValidateNested()
  @Type(() => ShortAuthoredTextDto)
  lead?: ShortAuthoredTextDto;

  @ValidateIf((decision: DecisionEditDto) => decision.key === undefined)
  @IsDefined()
  @ValidateNested()
  @Type(() => LongAuthoredTextDto)
  body?: LongAuthoredTextDto;
}

/**
 * Partial update of the `governance_overview` singleton. Every section is
 * optional — the service writes and audits only the sections actually
 * present, and each provided section is a full replacement array (supports
 * add/remove/reorder, unlike the Finances DTO's index-addressed partial
 * edits). The global `ValidationPipe` runs with `whitelist` +
 * `forbidNonWhitelisted`, so an unknown field is a 400.
 */
export class UpdateAdminOverviewDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HealthStatEditDto)
  health?: HealthStatEditDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ModerationStepEditDto)
  moderationSteps?: ModerationStepEditDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CouncilSeatEditDto)
  council?: CouncilSeatEditDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PrincipleEditDto)
  principles?: PrincipleEditDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DecisionEditDto)
  decisions?: DecisionEditDto[];

  /** Free-text reason, recorded on every audit row this request produces. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
