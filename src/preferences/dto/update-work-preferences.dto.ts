import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
} from 'class-validator';
import { OutAtWork } from '../entities/member-preferences.entity';
import { TRANS_SUPPORT_IDS } from '../trans-support';
import { WORK_SKILL_IDS } from '../work-skills';
import { FOCUS_AREA_IDS } from '../focus-areas';

// `PUT /me/work-preferences` is a full REPLACE of all three settings, not a
// merge — the frontend's WorkProfilePage holds the complete triple in state and
// submits it whole. Every field is therefore REQUIRED: an omitted field on a
// safety form would otherwise silently keep an old value the member believes
// they just changed.
export class UpdateWorkPreferencesDto {
  // `@IsEnum` over the shared TS enum — same idiom as `visibility` in
  // `UpdateProfileDto`, which is the repo's precedent for a closed set backed
  // by a Postgres enum type.
  @IsEnum(OutAtWork)
  outAtWork!: OutAtWork;

  // An unknown id is a 400 here, never a stored value — see the reasoning on
  // `normalizeTransSupport`.
  @IsArray()
  @ArrayMaxSize(TRANS_SUPPORT_IDS.length)
  @IsIn(TRANS_SUPPORT_IDS, { each: true })
  transSupport!: string[];

  @IsBoolean()
  safeOnly!: boolean;

  // Skills-exchange multi-selects. Unknown ids are a 400 here, never stored —
  // same treatment as `transSupport`. `ArrayMaxSize` on the vocabulary length
  // stops a caller padding the array with duplicates past what the form offers.
  @IsArray()
  @ArrayMaxSize(WORK_SKILL_IDS.length)
  @IsIn(WORK_SKILL_IDS, { each: true })
  skills!: string[];

  @IsArray()
  @ArrayMaxSize(FOCUS_AREA_IDS.length)
  @IsIn(FOCUS_AREA_IDS, { each: true })
  focusAreas!: string[];
}
