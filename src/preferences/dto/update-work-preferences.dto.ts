import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
} from 'class-validator';
import { OutAtWork } from '../entities/member-preferences.entity';
import { TRANS_SUPPORT_IDS } from '../trans-support';

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
  outAtWork: OutAtWork;

  // An unknown id is a 400 here, never a stored value — see the reasoning on
  // `normalizeTransSupport`.
  @IsArray()
  @ArrayMaxSize(TRANS_SUPPORT_IDS.length)
  @IsIn(TRANS_SUPPORT_IDS, { each: true })
  transSupport: string[];

  @IsBoolean()
  safeOnly: boolean;
}
