import { MemberRef } from '../common/member-ref';
import {
  FlatmateProfile,
  FlatmateProfileType,
} from './entities/flatmate-profile.entity';

/** Wire shape for a flatmate profile. `member` is the compact identity ref;
 * `matchScore` is present on the member browse (relative to the viewer's own
 * profile, opposite type) and `null` otherwise. */
export interface FlatmateProfileDTO {
  slug: string;
  type: FlatmateProfileType;
  member: MemberRef | null;
  pronouns: string;
  neighbourhood: string;
  budgetEuros: number;
  moveInFrom: string | null;
  flexibleTiming: boolean;
  about: string;
  lifestyleTags: string[];
  createdAt: string;
  matchScore: number | null;
}

export function toFlatmateProfileDTO(
  profile: FlatmateProfile,
  member: MemberRef | null,
  matchScore: number | null,
): FlatmateProfileDTO {
  return {
    slug: profile.slug,
    type: profile.type,
    member,
    pronouns: profile.pronouns,
    neighbourhood: profile.neighbourhood,
    budgetEuros: profile.budgetEuros,
    moveInFrom: profile.moveInFrom,
    flexibleTiming: profile.flexibleTiming,
    about: profile.about,
    lifestyleTags: profile.lifestyleTags,
    createdAt: profile.createdAt.toISOString(),
    matchScore,
  };
}
