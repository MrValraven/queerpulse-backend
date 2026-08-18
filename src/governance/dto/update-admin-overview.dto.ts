import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * Every `*Key`/`icon`/`tint` catalog below is copied verbatim from
 * `governance-overview.seed.ts` — the fixed set of content keys that already
 * have EN+PT translations. Validating against these (rather than accepting
 * any string) is what stops an admin submission from ever producing an
 * orphan key that 404s or renders untranslated on the public page (see
 * [[seed-backed-content-404s-in-prod]]).
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

export class CouncilSeatEditDto {
  @IsString()
  @MaxLength(80)
  name!: string;

  @IsString()
  @MaxLength(4)
  initials!: string;

  @IsIn(COUNCIL_ROLE_KEYS)
  roleKey!: CouncilRoleKey;

  @IsIn(COUNCIL_TINTS)
  tint!: CouncilTint;
}

export class PrincipleEditDto {
  @IsIn(PRINCIPLE_KEYS)
  key!: PrincipleKey;

  @IsIn(PRINCIPLE_ICONS)
  icon!: PrincipleIcon;
}

export class DecisionEditDto {
  @IsIn(DECISION_KEYS)
  key!: DecisionKey;
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
