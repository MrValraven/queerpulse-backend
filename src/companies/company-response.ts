import { MemberRef } from '../common/member-ref';
import { JobCardDTO } from '../jobs/job-response';
import { CompanyReview } from './entities/company-review.entity';
import {
  Company,
  CompanyHiringContact,
  CompanyInfoItem,
  CompanyValue,
  CompanyWorkItem,
} from './entities/company.entity';

export interface CompanyBadges {
  queerRun: boolean;
  queerLed: boolean;
  verified: boolean;
}

export interface CompanyReviewBars {
  one: number;
  two: number;
  three: number;
  four: number;
  five: number;
}

/**
 * The three review-derived numbers every card/detail view needs, computed
 * from the raw `stars` values of a company's reviews (mirrors
 * `CommunityStats`'s "batched once per page" shape via
 * `CompaniesService.reviewAggregatesForMany`).
 */
export interface CompanyReviewAggregates {
  reviewScore: number | null; // avg stars, null if no reviews
  reviewCount: number;
  reviewBars: CompanyReviewBars;
}

export const EMPTY_REVIEW_AGGREGATES: CompanyReviewAggregates = {
  reviewScore: null,
  reviewCount: 0,
  reviewBars: { one: 0, two: 0, three: 0, four: 0, five: 0 },
};

export interface CompanyCardDTO {
  slug: string;
  nameText: string;
  tagline: string;
  badges: CompanyBadges;
  reviewScore: number | null;
  reviewCount: number;
  openRolesCount: number;
}

export interface CompanyDetailDTO extends CompanyCardDTO {
  about: string;
  values: CompanyValue[];
  info: CompanyInfoItem[];
  team: MemberRef[];
  teamCount: number;
  hiringContact: CompanyHiringContact | null;
  work: CompanyWorkItem[];
  reviewBars: CompanyReviewBars;
  openRoles: JobCardDTO[];
  owner: MemberRef | null;
  isOwner: boolean;
  createdAt: string;
}

export interface CompanyReviewDTO {
  id: string;
  author: MemberRef | null;
  title: string;
  stars: number;
  byline: string;
  body: string[];
  createdAt: string;
}

function toBadges(c: Company): CompanyBadges {
  return { queerRun: c.queerRun, queerLed: c.queerLed, verified: c.verified };
}

export function toCompanyCard(
  c: Company,
  aggregates: CompanyReviewAggregates,
  openRolesCount: number,
): CompanyCardDTO {
  return {
    slug: c.slug,
    nameText: c.nameText,
    tagline: c.tagline,
    badges: toBadges(c),
    reviewScore: aggregates.reviewScore,
    reviewCount: aggregates.reviewCount,
    openRolesCount,
  };
}

export function toCompanyDetail(
  c: Company,
  aggregates: CompanyReviewAggregates,
  team: MemberRef[],
  owner: MemberRef | null,
  isOwner: boolean,
  openRoles: JobCardDTO[],
): CompanyDetailDTO {
  return {
    ...toCompanyCard(c, aggregates, openRoles.length),
    about: c.about,
    values: c.values,
    info: c.info,
    team,
    teamCount: c.teamCount,
    hiringContact: c.hiringContact,
    work: c.work,
    reviewBars: aggregates.reviewBars,
    openRoles,
    owner,
    isOwner,
    createdAt: c.createdAt.toISOString(),
  };
}

export function toCompanyReview(
  r: CompanyReview,
  author: MemberRef | null,
): CompanyReviewDTO {
  return {
    id: r.id,
    author,
    title: r.title,
    stars: r.stars,
    byline: r.byline,
    body: r.body,
    createdAt: r.createdAt.toISOString(),
  };
}

/** One-indexed star -> `CompanyReviewBars` key, in order. */
const BAR_KEYS: (keyof CompanyReviewBars)[] = [
  'one',
  'two',
  'three',
  'four',
  'five',
];

/**
 * Builds `{reviewScore,reviewCount,reviewBars}` from a company's raw review
 * `stars` values. `reviewScore` is `null` (not `0`/`NaN`) when there are no
 * reviews, per the spec.
 */
export function computeReviewAggregates(
  starsValues: number[],
): CompanyReviewAggregates {
  if (!starsValues.length) {
    return {
      reviewScore: null,
      reviewCount: 0,
      reviewBars: { one: 0, two: 0, three: 0, four: 0, five: 0 },
    };
  }

  const reviewBars: CompanyReviewBars = {
    one: 0,
    two: 0,
    three: 0,
    four: 0,
    five: 0,
  };
  let sum = 0;
  for (const stars of starsValues) {
    sum += stars;
    const key = BAR_KEYS[stars - 1];
    if (key) reviewBars[key] += 1;
  }

  return {
    reviewScore: sum / starsValues.length,
    reviewCount: starsValues.length,
    reviewBars,
  };
}
