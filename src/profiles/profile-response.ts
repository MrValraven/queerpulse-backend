import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { Activity } from './entities/activity.entity';
import { BoardPost } from './entities/board-post.entity';
import { Shaping, ShapingKind } from './entities/shaping.entity';
import { Skill } from './entities/skill.entity';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem } from './entities/work-item.entity';

export interface ProfileCard {
  slug: string;
  firstName: string;
  lastName: string;
  pronouns: string | null;
  tagline: string | null;
  avatarUrl: string | null;
  tags: string[];
  vouchCount: number;
  visibility: string;
}

export interface SocialLinkView {
  platform: string;
  urlOrHandle: string;
}

export interface WorkView {
  category: string;
  title: string;
  year: string;
  imageUrl: string | null;
}

export interface BoardView {
  kind: string;
  title: string;
  slug: string;
}

export interface SkillView {
  name: string;
  meta: string;
}

export interface GroupView {
  name: string;
  role: string;
}

export interface ShapingView {
  kind: string;
  title: string;
  note: string;
}

export interface ActivityView {
  kind: string;
  title: string;
  sub: string | null;
  to: string | null;
}

export interface ProfileRelations {
  socials: SocialLink[];
  work: WorkItem[];
  board: BoardPost[];
  skills: Skill[];
  groups: GroupView[];
  shapings: Shaping[];
  activity: Activity[];
  related: ProfileCard[];
}

export interface FullProfileResponse extends ProfileCard {
  verified: boolean;
  joinedAt: string;
  bio: string | null;
  location: string | null;
  now: string | null;
  openTo: string[];
  socials: SocialLinkView[];
  work: WorkView[];
  board: BoardView[];
  skills: SkillView[];
  groups: GroupView[];
  shapings: ShapingView[];
  activity: ActivityView[];
  related: ProfileCard[];
  limited: false;
}

export interface LimitedProfileResponse extends ProfileCard {
  verified: boolean;
  joinedAt: string;
  openTo: [];
  socials: [];
  work: [];
  board: [];
  skills: [];
  groups: [];
  shapings: [];
  activity: [];
  related: [];
  limited: true;
}

// Retained for the members list endpoint (searchMembers), which uses a card
// shape with extra location/openTo fields.
export interface MemberCard extends ProfileCard {
  location: string | null;
  openTo: string[];
}

export const SHAPING_KIND_ORDER: ShapingKind[] = [
  ShapingKind.Film,
  ShapingKind.Book,
  ShapingKind.Song,
  ShapingKind.Moment,
];

export function sortShapings(rows: Shaping[]): Shaping[] {
  return [...rows].sort(
    (a, b) =>
      SHAPING_KIND_ORDER.indexOf(a.kind) - SHAPING_KIND_ORDER.indexOf(b.kind),
  );
}

export function toProfileCard(p: Profile, vouchCount: number): ProfileCard {
  return {
    slug: p.slug,
    firstName: p.firstName,
    lastName: p.lastName,
    pronouns: p.pronouns,
    tagline: p.tagline,
    avatarUrl: p.avatarUrl,
    tags: p.tags,
    vouchCount,
    visibility: p.visibility,
  };
}

export function toMemberCard(p: Profile, vouchCount: number): MemberCard {
  // The directory lists every member (§8), but only `open` profiles expose
  // location/openTo on the card — `network`/`private` keep them blank here,
  // mirroring toLimitedProfile so the card can't leak what the profile detail
  // deliberately hides.
  const open = p.visibility === ProfileVisibility.Open;
  return {
    ...toProfileCard(p, vouchCount),
    location: open ? p.location : null,
    openTo: open ? p.openTo : [],
  };
}

export function toFullProfile(
  p: Profile,
  rels: ProfileRelations,
  vouchCount: number,
): FullProfileResponse {
  return {
    ...toProfileCard(p, vouchCount),
    verified: p.verified,
    joinedAt: p.joinedAt.toISOString(),
    bio: p.bio,
    location: p.location,
    now: p.now,
    openTo: p.openTo,
    socials: rels.socials.map((s) => ({
      platform: s.platform,
      urlOrHandle: s.urlOrHandle,
    })),
    work: rels.work.map((w) => ({
      category: w.category,
      title: w.title,
      year: w.year,
      imageUrl: w.imageUrl,
    })),
    board: rels.board.map((b) => ({
      kind: b.kind,
      title: b.title,
      slug: b.slug,
    })),
    skills: rels.skills.map((s) => ({ name: s.name, meta: s.meta })),
    groups: rels.groups,
    shapings: sortShapings(rels.shapings).map((s) => ({
      kind: s.kind,
      title: s.title,
      note: s.note,
    })),
    activity: rels.activity.map((a) => ({
      kind: a.kind,
      title: a.title,
      sub: a.sub,
      to: a.toLink,
    })),
    related: rels.related,
    limited: false,
  };
}

export function toLimitedProfile(
  p: Profile,
  vouchCount: number,
): LimitedProfileResponse {
  return {
    ...toProfileCard(p, vouchCount),
    verified: p.verified,
    joinedAt: p.joinedAt.toISOString(),
    openTo: [],
    socials: [],
    work: [],
    board: [],
    skills: [],
    groups: [],
    shapings: [],
    activity: [],
    related: [],
    limited: true,
  };
}
