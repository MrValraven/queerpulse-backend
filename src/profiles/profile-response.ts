import { toImageUrl } from '../common/image-url';
import type { CropRect } from '../media-crops/crop-rect';
import { cropFor } from '../media-crops/crop-response';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { directoryBlurb } from './directory-blurb';
import { FeaturedCommunityRefView } from './featured-communities';
import { Activity } from './entities/activity.entity';
import { BoardPost } from './entities/board-post.entity';
import { Shaping, ShapingKind } from './entities/shaping.entity';
import { Skill } from './entities/skill.entity';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem, WorkLink } from './entities/work-item.entity';
import { ActivityBand } from './last-active';
import { OpenToEntry } from './open-to';
import { facetsForLabels } from './identities';
import { matchNeighbourhood } from './neighbourhoods';

export interface ProfileCard {
  slug: string;
  firstName: string;
  lastName: string;
  pronouns: string | null;
  // How the member's name is said aloud. Ungated — same as `pronouns` above.
  pronunciation: string | null;
  tagline: string | null;
  avatarUrl: string | null;
  tags: string[];
  // Professional-identity facts, ungated by `visibility` — same as `tags`
  // above. See Profile.discipline/profession/languages and
  // src/profiles/professions.ts.
  discipline: string[];
  profession: string[];
  languages: string[];
  vouchCount: number;
  visibility: string;
  // Member-controlled visibility toggles. These are ALWAYS the true stored
  // value, for every viewer — they say whether the corresponding CONTENT
  // (avatarUrl/location/vouchers list) is gated, they are never themselves
  // gated. The owner reads them to render the real settings-sheet toggle
  // state; a non-owner viewer can use them to know whether e.g. calling the
  // vouchers-list endpoint is worth it. See toFullProfile's isOwner gating.
  photoVisible: boolean;
  hoodVisible: boolean;
  vouchersVisible: boolean;
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
  /** Crop rect for `imageUrl`, when the owner reframed it. */
  crop?: CropRect;
  links: WorkLink[];
}

export interface BoardView {
  kind: string;
  title: string;
  slug: string;
  status: string;
  closedNote: string | null;
  closedAt: string | null;
  expiresAt: string;
  createdAt: string;
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
  featuredCommunities: FeaturedCommunityRefView[];
}

/**
 * How many of the VIEWER's own accepted connections have vouched for the
 * member whose profile this is: the "three members you know vouched for them"
 * trust cue, computed per read because it is viewer-relative and therefore
 * never a column.
 *
 * `null` means "no answer", and there are exactly two reasons for it, both
 * deliberate:
 *  - the viewer IS the member (mutual vouchers with yourself is not a
 *    question), and
 *  - the member has turned `vouchersVisible` off. A viewer-relative count over
 *    a set the viewer already knows by name is a partial roster: with three
 *    connections and a count of one, the viewer has narrowed "who vouched for
 *    them" to three people, and often to one. A member who hid their roster
 *    hid it from this read too. `null` is honest where `0` would be a lie
 *    ("nobody you know did") about a set the viewer is not allowed to see, and
 *    it leaks nothing new: `vouchersVisible` is already on the wire for every
 *    viewer (see ProfileCard).
 *
 * `0` therefore always means the real answer is zero.
 */
export type MutualVoucherCount = number | null;

export interface FullProfileResponse extends ProfileCard {
  verified: boolean;
  joinedAt: string;
  // See MutualVoucherCount. Gated in ProfilesService, never here.
  mutualVoucherCount: MutualVoucherCount;
  // The coarse "recently active" band, or `null` when the member has opted out
  // (for any viewer but themselves) and when nothing has been recorded yet.
  // NEVER a timestamp: the finest value behind this is a month, and the finest
  // value on the wire is one of three buckets. See ./last-active.ts, and note
  // that `LimitedProfileResponse` deliberately carries no band at all, same as
  // it carries no location or openTo.
  activityBand: ActivityBand | null;
  bio: string | null;
  // Portuguese translation of `bio`. Ungated — same as `bio` above.
  bioPt: string | null;
  location: string | null;
  now: string | null;
  // What the member is explicitly not here for, shown alongside `now`.
  // Ungated — same as `now` above.
  notHereFor: string | null;
  openTo: OpenToEntry[];
  // Private Interests preferences — populated only when the requester is the
  // profile owner; `[]` for everyone else (see toFullProfile's `isOwner`).
  identities: string[];
  lookingFor: string[];
  // Member's own choice of whether the above is visible to other viewers.
  lookingForPublic: boolean;
  // Private preference — populated only for the profile owner (see
  // toFullProfile's `isOwner`); omitted entirely for every other viewer so it
  // never leaks on another member's public/network profile.
  privateNetwork?: boolean;
  // Owner-only: the member's consent to being featured on the admin-curated
  // homepage (see Profile.featuredConsent). Never surfaced to non-owner
  // viewers, mirroring privateNetwork above.
  featuredConsent?: boolean;
  // Owner-only: when set and in the future, the member has hidden their
  // profile until this instant (see Profile.hiddenUntil /
  // UpdateProfileDto.hiddenUntil). Never surfaced to non-owner viewers,
  // mirroring privateNetwork/featuredConsent above — knowing exactly when
  // someone will reappear from hiding is itself a minor privacy leak.
  hiddenUntil?: string | null;
  socials: SocialLinkView[];
  work: WorkView[];
  board: BoardView[];
  skills: SkillView[];
  groups: GroupView[];
  shapings: ShapingView[];
  activity: ActivityView[];
  related: ProfileCard[];
  // Communities the member has pinned to their profile, resolved for display.
  // Visible to anyone who can see the full profile (self/open/connected), like
  // the other public sections; empty on the limited card.
  featuredCommunities: FeaturedCommunityRefView[];
  limited: false;
}

export interface LimitedProfileResponse extends ProfileCard {
  verified: boolean;
  joinedAt: string;
  // Carried on the limited card on purpose, unlike location/openTo/activity.
  // The limited card is precisely the "should I send this stranger a
  // connection request?" surface, which is where a trust cue is worth most,
  // and it discloses no more than the ungated `vouchCount` already beside it.
  // Same gate as the full profile: see MutualVoucherCount.
  mutualVoucherCount: MutualVoucherCount;
  openTo: [];
  socials: [];
  work: [];
  board: [];
  skills: [];
  groups: [];
  shapings: [];
  activity: [];
  related: [];
  featuredCommunities: [];
  limited: true;
}

// Retained for the members list endpoint (searchMembers), which uses a card
// shape with extra location/openTo fields.
export interface MemberCard extends ProfileCard {
  location: string | null;
  openTo: OpenToEntry[];
  // Neighbourhood matched out of `location` — see neighbourhoods.ts. Gated
  // behind `open` visibility, same as `location`/`openTo` above, since it's
  // derived from `location` and must not leak it indirectly for a
  // network/private profile.
  hood: string | null;
  // Directory facets this member's PUBLISHED identities answer to — the
  // inverse of the `?identities=` query filter, present so the directory's
  // per-facet count badges have something to count. See
  // `identities.ts#facetsForLabels`.
  identityFacets: string[];
  // Years on QueerPulse, floor-rounded from `joinedAt`. Ungated — mirrors the
  // `MostVouched` sort's vouchCount in being a plain derived number, not
  // profile content.
  years: number;
  // The coarse "recently active" band. `null` covers three distinct cases the
  // card renders identically (as nothing at all): the member opted out, the
  // member has held no session since the signal existed, and this build simply
  // did not ask for it. See ./last-active.ts.
  activityBand: ActivityBand | null;
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
    pronunciation: profile.pronunciation,
    tagline: profile.tagline,
    avatarUrl: toImageUrl(profile.avatarUrl),
    tags: profile.tags,
    discipline: profile.discipline ?? [],
    profession: profile.profession ?? [],
    languages: profile.languages ?? [],
    vouchCount,
    visibility: profile.visibility,
    photoVisible: profile.photoVisible,
    hoodVisible: profile.hoodVisible,
    vouchersVisible: profile.vouchersVisible,
  };
}

/** Whole years between `joinedAt` and now, floor-rounded (never negative). */
function tenureYears(joinedAt: Date): number {
  const ms = Date.now() - joinedAt.getTime();
  return Math.max(0, Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000)));
}

/**
 * `avatarUrl` gated by the member's `photoVisible` toggle. `isOwner` means
 * "this card's subject IS the viewer" — true for the profile owner's own
 * full/limited profile read, but ALSO true when a member turns up as their
 * OWN row in a directory search result or another profile's `related` list;
 * either way they always see their own real photo. Everyone else sees `null`
 * once the member has turned `photoVisible` off. Shared by `toFullProfile`,
 * `toMemberCard`, and `ProfilesService.loadRelated`'s `related` list so the
 * three non-owner-facing card surfaces can't drift out of sync with each
 * other.
 */
export function gateAvatarUrl(p: Profile, isOwner: boolean): string | null {
  return isOwner || p.photoVisible ? toImageUrl(p.avatarUrl) : null;
}

/**
 * `location` gated by the member's `hoodVisible` toggle — same shape as
 * `gateAvatarUrl` above, shared for the same reason.
 */
export function gateLocation(p: Profile, isOwner: boolean): string | null {
  return isOwner || p.hoodVisible ? p.location : null;
}

export function toMemberCard(
  p: Profile,
  vouchCount: number,
  // Whether this card's subject IS the viewer running the search — see
  // `gateAvatarUrl`. Directory search never excludes the viewer's own
  // profile from their own results (see `ProfilesService.searchMembers`), so
  // this can legitimately be true, not just a theoretical parameter.
  isOwner = false,
  // Resolved by the caller through `visibleBand`, which is where the member's
  // opt-out is applied. Defaults to `null` so a caller that has no signal in
  // scope renders no band rather than an invented one.
  activityBand: ActivityBand | null = null,
): MemberCard {
  // The directory lists every member (§8), but only `open` profiles expose
  // location/openTo on the card — `network`/`private` keep them blank here,
  // mirroring toLimitedProfile so the card can't leak what the profile detail
  // deliberately hides. `hood` is derived from `location` and follows the
  // same gate for the same reason. Layered with the `hoodVisible` member
  // toggle: a viewer only ever sees `location`/`hood` when BOTH the profile
  // is `open` AND (they are the owner OR the member opted into `hoodVisible`).
  const open = p.visibility === ProfileVisibility.Open;
  const locationVisible = open && (isOwner || p.hoodVisible);
  return {
    ...toProfileCard(p, vouchCount),
    // The card DTO deliberately omits `bio`, so a browser can't do this itself —
    // the fallback has to happen here, where the bio is in scope. See
    // ./directory-blurb.ts; this is the list path only.
    tagline: directoryBlurb(p.tagline, p.bio),
    avatarUrl: gateAvatarUrl(p, isOwner),
    location: locationVisible ? p.location : null,
    openTo: open ? p.openTo : [],
    hood: locationVisible ? matchNeighbourhood(p.location) : null,
    identityFacets: facetsForLabels(p.discoverableIdentities ?? []),
    years: tenureYears(p.joinedAt),
    activityBand,
  };
}

export function toBoardView(b: BoardPost): BoardView {
  return {
    kind: b.kind,
    title: b.title,
    slug: b.slug,
    status: b.status,
    closedNote: b.closedNote,
    closedAt: b.closedAt?.toISOString() ?? null,
    expiresAt: b.expiresAt.toISOString(),
    createdAt: b.createdAt.toISOString(),
  };
}

export function toFullProfile(
  p: Profile,
  rels: ProfileRelations,
  vouchCount: number,
  // The Interests preferences are private; only surface them to the owner. Any
  // other viewer of a full (open/network) profile gets empty arrays.
  isOwner = false,
  // Pre-loaded crop lookup for `rels.work[].imageUrl` — the caller batches ONE
  // `MediaCropService.getMany` for the whole profile read and passes the
  // resulting Map straight through; this mapper stays synchronous.
  crops: Map<string, CropRect> = new Map(),
  // Already gated by `visibleBand` in the caller: this mapper never decides
  // whether the band may be shown, exactly like `crops` above is never fetched
  // here.
  activityBand: ActivityBand | null = null,
  // Already gated by the caller, exactly like `activityBand` above: this
  // mapper never decides whether the count may be shown. See
  // MutualVoucherCount and ProfilesService.loadMutualVoucherCount.
  mutualVoucherCount: MutualVoucherCount = null,
): FullProfileResponse {
  return {
    ...toProfileCard(p, vouchCount),
    verified: p.verified,
    joinedAt: p.joinedAt.toISOString(),
    mutualVoucherCount,
    activityBand,
    bio: p.bio,
    bioPt: p.bioPt,
    // Overrides the ungated `avatarUrl` the spread above copied from
    // toProfileCard: a non-owner viewer sees the real photo only when the
    // member has opted in via `photoVisible`. The owner always sees their own
    // photo, same as every other owner-only override in this mapper. See
    // gateAvatarUrl/gateLocation, shared with toMemberCard/loadRelated so the
    // three non-owner-facing card surfaces can't drift out of sync.
    avatarUrl: gateAvatarUrl(p, isOwner),
    location: gateLocation(p, isOwner),
    now: p.now,
    notHereFor: p.notHereFor,
    openTo: p.openTo,
    identities: isOwner ? (p.identities ?? []) : [],
    // Owner always sees their own list; others see it only when the member has
    // opted in via lookingForPublic.
    lookingFor: isOwner || p.lookingForPublic ? (p.lookingFor ?? []) : [],
    lookingForPublic: p.lookingForPublic ?? false,
    // Owner-only: never included in the object for a non-owner viewer, so it
    // cannot leak on another member's full profile response.
    ...(isOwner ? { privateNetwork: p.privateNetwork ?? false } : {}),
    ...(isOwner ? { featuredConsent: p.featuredConsent ?? false } : {}),
    ...(isOwner ? { hiddenUntil: p.hiddenUntil?.toISOString() ?? null } : {}),
    socials: rels.socials.map((s) => ({
      platform: s.platform,
      urlOrHandle: s.urlOrHandle,
    })),
    work: rels.work.map((workItem) => ({
      category: workItem.category,
      title: workItem.title,
      year: workItem.year,
      imageUrl: toImageUrl(workItem.imageUrl),
      crop: cropFor(workItem.imageUrl, crops),
      links: workItem.links,
    })),
    board: rels.board.map(toBoardView),
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
    featuredCommunities: rels.featuredCommunities,
    limited: false,
  };
}

export function toLimitedProfile(
  p: Profile,
  vouchCount: number,
  // Whether this card's subject IS the viewer — see `gateAvatarUrl`. A
  // limited profile is by definition almost always viewed by a non-owner
  // (that's why it's limited), but this mirrors `toFullProfile`/
  // `toMemberCard`'s signature rather than assuming `isOwner` is always
  // false, in case an owner-preview code path exists somewhere.
  isOwner = false,
  // Already gated by the caller. See MutualVoucherCount.
  mutualVoucherCount: MutualVoucherCount = null,
): LimitedProfileResponse {
  return {
    ...toProfileCard(p, vouchCount),
    // Overrides the ungated `avatarUrl`/`location`-adjacent fields the spread
    // above copied from toProfileCard — same gating as toFullProfile/
    // toMemberCard, so a `photoVisible: false` limited profile can't ship a
    // working real avatarUrl alongside that flag. See gateAvatarUrl.
    avatarUrl: gateAvatarUrl(p, isOwner),
    verified: p.verified,
    joinedAt: p.joinedAt.toISOString(),
    mutualVoucherCount,
    openTo: [],
    socials: [],
    work: [],
    board: [],
    skills: [],
    groups: [],
    shapings: [],
    activity: [],
    related: [],
    featuredCommunities: [],
    limited: true,
  };
}
