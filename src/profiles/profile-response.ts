import { toImageUrl } from '../common/image-url';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { directoryBlurb } from './directory-blurb';
import { Activity } from './entities/activity.entity';
import { BoardPost } from './entities/board-post.entity';
import { Shaping, ShapingKind } from './entities/shaping.entity';
import { Skill } from './entities/skill.entity';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem } from './entities/work-item.entity';
import { OpenToEntry } from './open-to';

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
  openTo: OpenToEntry[];
  // Private Interests preferences — populated only when the requester is the
  // profile owner; `[]` for everyone else (see toFullProfile's `isOwner`).
  identities: string[];
  lookingFor: string[];
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
  openTo: OpenToEntry[];
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

// The RAW card, carrying the member's tagline exactly as they wrote it. Used by
// the profile endpoints (via toFullProfile/toLimitedProfile) and by `related`.
// Do NOT resolve the directory blurb fallback here: the profile editor seeds its
// short-bio input from this field, so borrowed bio text would let a member save
// words they never typed. The fallback belongs to the list path — toMemberCard.
export function toProfileCard(
  profile: Profile,
  vouchCount: number,
): ProfileCard {
  return {
    slug: profile.slug,
    firstName: profile.firstName,
    lastName: profile.lastName,
    pronouns: profile.pronouns,
    tagline: profile.tagline,
    avatarUrl: toImageUrl(profile.avatarUrl),
    tags: profile.tags,
    vouchCount,
    visibility: profile.visibility,
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
    // The card DTO deliberately omits `bio`, so a browser can't do this itself —
    // the fallback has to happen here, where the bio is in scope. See
    // ./directory-blurb.ts; this is the list path only.
    tagline: directoryBlurb(p.tagline, p.bio),
    location: open ? p.location : null,
    openTo: open ? p.openTo : [],
  };
}

export function toFullProfile(
  p: Profile,
  rels: ProfileRelations,
  vouchCount: number,
  // The Interests preferences are private; only surface them to the owner. Any
  // other viewer of a full (open/network) profile gets empty arrays.
  isOwner = false,
): FullProfileResponse {
  return {
    ...toProfileCard(p, vouchCount),
    verified: p.verified,
    joinedAt: p.joinedAt.toISOString(),
    bio: p.bio,
    location: p.location,
    now: p.now,
    openTo: p.openTo,
    identities: isOwner ? (p.identities ?? []) : [],
    lookingFor: isOwner ? (p.lookingFor ?? []) : [],
    socials: rels.socials.map((s) => ({
      platform: s.platform,
      urlOrHandle: s.urlOrHandle,
    })),
    work: rels.work.map((workItem) => ({
      category: workItem.category,
      title: workItem.title,
      year: workItem.year,
      imageUrl: toImageUrl(workItem.imageUrl),
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
