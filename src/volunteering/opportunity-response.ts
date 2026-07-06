import { MemberRef } from '../common/member-ref';
import {
  OpportunityCause,
  OpportunityCommitLevel,
  OpportunityCommitment,
  OpportunityStatus,
  OpportunityTask,
  VolunteerOpportunity,
} from './entities/volunteer-opportunity.entity';
import { VolunteerSignup } from './entities/volunteer-signup.entity';

/**
 * Deliberately kept file-local rather than imported from `partners/` —
 * this is the minimal shape every mapper here needs, and it's structurally
 * identical to (duck-type compatible with) the `{slug,name}` refs
 * `PartnersService.refsByIds` returns, so no import/cycle is required.
 * `VolunteeringService` resolves `opportunity.partnerId` to one of these via
 * `partnerRefsForMany`, `null` when there's no linked partner.
 */
export interface PartnerRef {
  slug: string;
  name: string;
}

export interface OpportunityCardDTO {
  slug: string;
  org: string;
  partner: PartnerRef | null;
  role: string;
  cause: OpportunityCause;
  commit: OpportunityCommitLevel;
  time: string;
  location: string;
  skills: string[];
  desc: string;
  spotsTotal: number;
  spotsFilled: number;
  spotsPct: number;
  status: OpportunityStatus;
  createdAt: string;
}

export interface OpportunityDetailDTO extends OpportunityCardDTO {
  why: string[];
  tasks: OpportunityTask[];
  commitments: OpportunityCommitment[];
  goodFor: string[];
  teamIntro: string | null;
  team: MemberRef[];
  applyRole: string;
  poster: MemberRef | null;
  isPoster: boolean;
  mySignup: boolean;
}

export interface VolunteerSignupDTO {
  id: string;
  member: MemberRef | null;
  note: string | null;
  createdAt: string;
}

/**
 * Rounds `spotsFilled/spotsTotal` to a 0..100 percentage, guarding the
 * divide-by-zero case (`spotsTotal <= 0`, which shouldn't happen given
 * `CreateOpportunityDto.spotsTotal`'s `@Min(1)` but is defensive here anyway)
 * by reporting 0 rather than `NaN`/`Infinity`.
 */
function computeSpotsPct(spotsFilled: number, spotsTotal: number): number {
  if (spotsTotal <= 0) return 0;
  return Math.round((spotsFilled / spotsTotal) * 100);
}

export function toOpportunityCard(
  opportunity: VolunteerOpportunity,
  partner: PartnerRef | null,
  spotsFilled: number,
): OpportunityCardDTO {
  return {
    slug: opportunity.slug,
    org: opportunity.org,
    partner,
    role: opportunity.role,
    cause: opportunity.cause,
    commit: opportunity.commit,
    time: opportunity.time,
    location: opportunity.location,
    skills: opportunity.skills,
    desc: opportunity.desc,
    spotsTotal: opportunity.spotsTotal,
    spotsFilled,
    spotsPct: computeSpotsPct(spotsFilled, opportunity.spotsTotal),
    status: opportunity.status,
    createdAt: opportunity.createdAt.toISOString(),
  };
}

export function toOpportunityDetail(
  opportunity: VolunteerOpportunity,
  partner: PartnerRef | null,
  spotsFilled: number,
  team: MemberRef[],
  poster: MemberRef | null,
  isPoster: boolean,
  mySignup: boolean,
): OpportunityDetailDTO {
  return {
    ...toOpportunityCard(opportunity, partner, spotsFilled),
    why: opportunity.detail.why,
    tasks: opportunity.detail.tasks,
    commitments: opportunity.detail.commitments,
    goodFor: opportunity.detail.goodFor,
    teamIntro: opportunity.detail.teamIntro,
    team,
    applyRole: opportunity.applyRole,
    poster,
    isPoster,
    mySignup,
  };
}

export function toVolunteerSignup(
  signup: VolunteerSignup,
  member: MemberRef | null,
): VolunteerSignupDTO {
  return {
    id: signup.id,
    member,
    note: signup.note,
    createdAt: signup.createdAt.toISOString(),
  };
}
