import { Profile } from '../users/entities/profile.entity';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem } from './entities/work-item.entity';

export interface SocialLinkView {
  platform: string;
  urlOrHandle: string;
  position: number;
}

export interface WorkItemView {
  category: string;
  title: string;
  year: string;
  imageUrl: string | null;
  position: number;
}

export interface FullProfileResponse {
  slug: string;
  firstName: string;
  lastName: string;
  pronouns: string | null;
  tagline: string | null;
  bio: string | null;
  location: string | null;
  avatarUrl: string | null;
  visibility: string;
  openTo: string[];
  tags: string[];
  socials: SocialLinkView[];
  work: WorkItemView[];
  vouchCount: number;
  limited: false;
}

export interface LimitedProfileResponse {
  slug: string;
  firstName: string;
  lastName: string;
  pronouns: string | null;
  tagline: string | null;
  avatarUrl: string | null;
  visibility: string;
  vouchCount: number;
  limited: true;
}

export interface MemberCard {
  slug: string;
  firstName: string;
  lastName: string;
  pronouns: string | null;
  tagline: string | null;
  location: string | null;
  avatarUrl: string | null;
  tags: string[];
  openTo: string[];
  visibility: string;
  vouchCount: number;
}

export function toLimitedProfile(
  p: Profile,
  vouchCount: number,
): LimitedProfileResponse {
  return {
    slug: p.slug,
    firstName: p.firstName,
    lastName: p.lastName,
    pronouns: p.pronouns,
    tagline: p.tagline,
    avatarUrl: p.avatarUrl,
    visibility: p.visibility,
    vouchCount,
    limited: true,
  };
}

export function toFullProfile(
  p: Profile,
  socials: SocialLink[],
  work: WorkItem[],
  vouchCount: number,
): FullProfileResponse {
  return {
    slug: p.slug,
    firstName: p.firstName,
    lastName: p.lastName,
    pronouns: p.pronouns,
    tagline: p.tagline,
    bio: p.bio,
    location: p.location,
    avatarUrl: p.avatarUrl,
    visibility: p.visibility,
    openTo: p.openTo,
    tags: p.tags,
    socials: socials.map((s) => ({
      platform: s.platform,
      urlOrHandle: s.urlOrHandle,
      position: s.position,
    })),
    work: work.map((w) => ({
      category: w.category,
      title: w.title,
      year: w.year,
      imageUrl: w.imageUrl,
      position: w.position,
    })),
    vouchCount,
    limited: false,
  };
}

export function toMemberCard(p: Profile, vouchCount: number): MemberCard {
  return {
    slug: p.slug,
    firstName: p.firstName,
    lastName: p.lastName,
    pronouns: p.pronouns,
    tagline: p.tagline,
    location: p.location,
    avatarUrl: p.avatarUrl,
    tags: p.tags,
    openTo: p.openTo,
    visibility: p.visibility,
    vouchCount,
  };
}
