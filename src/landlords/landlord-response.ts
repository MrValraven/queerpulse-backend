import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
import { LandlordIntroRequest } from './entities/landlord-intro-request.entity';
import { LandlordRecommendation } from './entities/landlord-recommendation.entity';
import { Landlord, LandlordStat } from './entities/landlord.entity';

export type LandlordTint = 'coral' | 'jade' | 'plum';
const TINTS: LandlordTint[] = ['coral', 'jade', 'plum'];

/** Stable per-key tint so a card keeps its colour across requests. */
function tintForKey(key: string): LandlordTint {
  let hash = 0;
  for (const char of key) {
    hash = (hash + char.charCodeAt(0)) % TINTS.length;
  }
  return TINTS[hash];
}

/** Two-letter initials from a display name. */
function initialsForName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function memberName(member: MemberRef | null): string {
  if (!member) return '';
  return `${member.firstName} ${member.lastName}`.trim();
}

/** Aggregate star rating: mean to one decimal + count. Mirrors `listings`
 * `ratingFromReviews`. */
export function ratingFromRecommendations(recs: LandlordRecommendation[]): {
  score: string;
  count: number;
} {
  if (recs.length === 0) return { score: '0', count: 0 };
  const total = recs.reduce((sum, rec) => sum + rec.stars, 0);
  return { score: (total / recs.length).toFixed(1), count: recs.length };
}

export interface LandlordCardDTO {
  slug: string;
  name: string;
  initials: string;
  tint: LandlordTint;
  photo: string | null;
  hood: string;
  note: string;
  tagline: string;
  rating: { score: string; count: number };
}

export function toLandlordCardDTO(
  landlord: Landlord,
  rating: { score: string; count: number },
): LandlordCardDTO {
  return {
    slug: landlord.slug,
    name: landlord.name,
    initials: initialsForName(landlord.name),
    tint: tintForKey(landlord.slug),
    photo: toImageUrl(landlord.photo),
    hood: landlord.hood,
    note: landlord.note,
    tagline: landlord.tagline,
    rating,
  };
}

export interface RecommendationDTO {
  name: string;
  initials: string;
  tint: LandlordTint;
  member: MemberRef | null;
  stars: number;
  text: string;
  createdAt: string;
}

export function toRecommendationDTO(
  rec: LandlordRecommendation,
  member: MemberRef | null,
): RecommendationDTO {
  const name = memberName(member);
  return {
    name,
    initials: initialsForName(name),
    tint: tintForKey(rec.authorUserId),
    member,
    stars: rec.stars,
    text: rec.text,
    createdAt: rec.createdAt.toISOString(),
  };
}

export interface LandlordDetailDTO extends LandlordCardDTO {
  about: string[];
  areas: string[];
  rentingNote: string;
  stats: LandlordStat[];
  recommendations: RecommendationDTO[];
}

export function toLandlordDetailDTO(
  landlord: Landlord,
  recommendations: RecommendationDTO[],
  rating: { score: string; count: number },
): LandlordDetailDTO {
  return {
    ...toLandlordCardDTO(landlord, rating),
    about: landlord.about,
    areas: landlord.areas,
    rentingNote: landlord.rentingNote,
    stats: landlord.stats,
    recommendations,
  };
}

/** Admin-facing intro-request row (includes the landlord it targets). */
export interface IntroRequestDTO {
  id: string;
  landlordSlug: string;
  landlordName: string;
  name: string;
  note: string | null;
  contactEmail: string | null;
  status: LandlordIntroRequest['status'];
  createdAt: string;
}

export function toIntroRequestDTO(
  request: LandlordIntroRequest,
  landlord: Pick<Landlord, 'slug' | 'name'> | null,
): IntroRequestDTO {
  return {
    id: request.id,
    landlordSlug: landlord?.slug ?? '',
    landlordName: landlord?.name ?? '',
    name: request.name,
    note: request.note,
    contactEmail: request.contactEmail,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
  };
}
