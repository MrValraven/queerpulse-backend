import 'dotenv/config';
import { DataSource, EntityManager } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { OpenToEntry } from '../profiles/open-to';
import { Activity, ActivityKind } from '../profiles/entities/activity.entity';
import { BoardPost, BoardKind } from '../profiles/entities/board-post.entity';
import { Group } from '../profiles/entities/group.entity';
import { GroupMembership } from '../profiles/entities/group-membership.entity';
import { Shaping, ShapingKind } from '../profiles/entities/shaping.entity';
import { Skill } from '../profiles/entities/skill.entity';
import {
  Community,
  CommunityType,
  AccessTier,
} from '../communities/entities/community.entity';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import {
  CommunityPost,
  PostKind,
} from '../communities/entities/community-post.entity';
import {
  CommunityPostReaction,
  ReactionKey,
} from '../communities/entities/community-post-reaction.entity';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';
import {
  CommunityJoinRequest,
  JoinRequestStatus,
} from '../communities/entities/community-join-request.entity';
import { CompanyReview } from '../companies/entities/company-review.entity';
import { CompanyTeamMember } from '../companies/entities/company-team-member.entity';
import {
  Company,
  CompanyHiringContact,
  CompanyInfoItem,
  CompanyValue,
  CompanyWorkItem,
} from '../companies/entities/company.entity';
import {
  JobApplication,
  JobApplicationAnswer,
  JobApplicationStatus,
} from '../jobs/entities/job-application.entity';
import {
  Job,
  JobDetailBody,
  JobFormat,
  JobStatus,
} from '../jobs/entities/job.entity';
import { VolunteerOpportunityTeam } from '../volunteering/entities/volunteer-opportunity-team.entity';
import {
  OpportunityCause,
  OpportunityCommitLevel,
  OpportunityDetailBody,
  OpportunityStatus,
  VolunteerOpportunity,
} from '../volunteering/entities/volunteer-opportunity.entity';
import { VolunteerSignup } from '../volunteering/entities/volunteer-signup.entity';
import {
  Partner,
  PartnerAtGlance,
  PartnerContact,
  PartnerJointWork,
  PartnerRegion,
  PartnerSection,
  PartnerStat,
  PartnerStatus,
  PartnerTimelineItem,
} from '../partners/entities/partner.entity';
import { Listing, ListingStatus } from '../listings/entities/listing.entity';
import { ListingReview } from '../listings/entities/listing-review.entity';
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import {
  Report,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { ReasonCode } from '../reports/reason-catalogue';
import { deriveSeverity, slaDueAtFor } from '../reports/report-severity';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { ModActionCode } from '../moderation/dto/mod-action.dto';
import {
  Changemaker,
  ChangemakerStatus,
  ChangemakerTint,
} from '../changemakers/entities/changemaker.entity';
import {
  CHANGEMAKER_SETTINGS_ID,
  ChangemakerDirectorySettings,
} from '../changemakers/entities/changemaker-directory-settings.entity';
import { HousingCoop } from '../housing/entities/housing-coop.entity';
import { CoopJoinRequest } from '../housing/entities/coop-join-request.entity';

// Representative members for local frontend integration. Replace/extend with the
// prototype's mock members (frontend src/features/members/data/members.ts) as
// needed — the slugs are the integration key.
const MEMBERS: Array<{
  googleId: string;
  email: string;
  status: UserStatus;
  slug: string;
  firstName: string;
  lastName: string;
  pronouns: string | null;
  tagline: string | null;
  location: string | null;
  visibility: ProfileVisibility;
  tags: string[];
  openTo: OpenToEntry[];
  // Optional so the original three fixtures (whose verified/joinedAt are set
  // via the tomas-mendes special-case block below, or left at column
  // defaults for ana-rocha/noa-silva) stay untouched. Every member added
  // below for Task C1 (live-mode admin data) sets both explicitly so the
  // member-growth chart, "new this week" count, and verified mix are real.
  verified?: boolean;
  joinedAt?: string;
}> = [
  {
    googleId: 'seed-tomas',
    email: 'tomas@example.com',
    status: UserStatus.Active,
    slug: 'tomas-mendes',
    firstName: 'Tomás',
    lastName: 'Mendes',
    pronouns: 'he/him',
    tagline: 'Illustrator & zine-maker',
    location: 'Lisbon',
    visibility: ProfileVisibility.Open,
    tags: ['Illustration', 'Print'],
    openTo: [{ kind: 'preset', id: 'collaborating' }],
  },
  {
    googleId: 'seed-ana',
    email: 'ana@example.com',
    status: UserStatus.Active,
    slug: 'ana-rocha',
    firstName: 'Ana',
    lastName: 'Rocha',
    pronouns: 'she/her',
    tagline: 'Sound artist',
    location: 'Porto',
    visibility: ProfileVisibility.Network,
    tags: ['Music', 'Performance'],
    openTo: [{ kind: 'preset', id: 'mentoring' }],
  },
  {
    googleId: 'seed-noa',
    email: 'noa@example.com',
    status: UserStatus.Active,
    slug: 'noa-silva',
    firstName: 'Noa',
    lastName: 'Silva',
    pronouns: 'they/them',
    tagline: 'Curator',
    location: 'Braga',
    visibility: ProfileVisibility.Open,
    tags: ['Curation'],
    openTo: [
      { kind: 'preset', id: 'collaborating' },
      { kind: 'custom', label: 'Hiring' },
    ],
  },
  // NOTE: the `seed-pending` / `sam-pending` fixture that used to sit here has
  // been removed. `UserStatus.Pending` no longer exists — a person who is not a
  // member has no `users` row at all, only a `join_requests` row. This seed was
  // the last writer of that status anywhere in the codebase. Nothing referenced
  // the slug (no community roster, reaction, or reply), so it is dropped rather
  // than converted. To exercise the admin queue locally, POST to the now-public
  // `/join-requests` instead.

  // --- Task C1: live-mode admin data ---------------------------------------
  // The 14 members below exist so the admin Members list, vouch graph,
  // flagged/reports view, and moderation response-time chart all have real
  // data instead of the 3-member fixture above. `joinedAt` is spread across
  // the last ~10 weeks, with three members joined in the last 7 days (for the
  // "new this week" stat + member-growth chart); `verified` is a genuine mix.
  {
    googleId: 'seed-beatriz',
    email: 'beatriz.coelho@example.com',
    status: UserStatus.Active,
    slug: 'beatriz-coelho',
    firstName: 'Beatriz',
    lastName: 'Coelho',
    pronouns: 'she/her',
    tagline: 'Community organizer',
    location: 'Faro',
    visibility: ProfileVisibility.Open,
    tags: ['Organizing', 'Events'],
    openTo: [{ kind: 'preset', id: 'collaborating' }],
    verified: true,
    joinedAt: '2026-05-20T09:00:00.000Z',
  },
  {
    googleId: 'seed-diogo',
    email: 'diogo.antunes@example.com',
    status: UserStatus.Active,
    slug: 'diogo-antunes',
    firstName: 'Diogo',
    lastName: 'Antunes',
    pronouns: 'he/him',
    tagline: 'Backend developer, weekend DJ',
    location: 'Lisbon',
    visibility: ProfileVisibility.Open,
    tags: ['Engineering', 'Music'],
    openTo: [{ kind: 'preset', id: 'mentoring' }],
    verified: true,
    joinedAt: '2026-05-29T09:00:00.000Z',
  },
  {
    googleId: 'seed-marta',
    email: 'marta.esteves@example.com',
    status: UserStatus.Active,
    slug: 'marta-esteves',
    firstName: 'Marta',
    lastName: 'Esteves',
    pronouns: 'she/they',
    tagline: 'Peer support volunteer',
    location: 'Porto',
    visibility: ProfileVisibility.Network,
    tags: ['Peer support', 'Mental health'],
    openTo: [{ kind: 'preset', id: 'casualMeetups' }],
    verified: false,
    joinedAt: '2026-06-04T09:00:00.000Z',
  },
  {
    googleId: 'seed-rui',
    email: 'rui.cardoso@example.com',
    status: UserStatus.Active,
    slug: 'rui-cardoso',
    firstName: 'Rui',
    lastName: 'Cardoso',
    pronouns: 'he/him',
    tagline: 'Barista & zine collector',
    location: 'Braga',
    visibility: ProfileVisibility.Open,
    tags: ['Coffee', 'Zines'],
    openTo: [{ kind: 'preset', id: 'swaps' }],
    verified: false,
    joinedAt: '2026-06-18T09:00:00.000Z',
  },
  {
    googleId: 'seed-sofia',
    email: 'sofia.pinheiro@example.com',
    status: UserStatus.Active,
    slug: 'sofia-pinheiro',
    firstName: 'Sofia',
    lastName: 'Pinheiro',
    pronouns: 'she/her',
    tagline: 'Physiotherapist, trail runner',
    location: 'Coimbra',
    visibility: ProfileVisibility.Open,
    tags: ['Health', 'Running'],
    openTo: [{ kind: 'preset', id: 'clientWork' }],
    verified: true,
    joinedAt: '2026-05-19T09:00:00.000Z',
  },
  {
    googleId: 'seed-kai',
    email: 'kai.duarte@example.com',
    status: UserStatus.Active,
    slug: 'kai-duarte',
    firstName: 'Kai',
    lastName: 'Duarte',
    pronouns: 'they/them',
    tagline: 'Game designer',
    location: 'Lisbon',
    visibility: ProfileVisibility.Network,
    tags: ['Games', 'Design'],
    openTo: [{ kind: 'preset', id: 'collaborating' }],
    verified: false,
    joinedAt: '2026-06-14T09:00:00.000Z',
  },
  {
    googleId: 'seed-leonor',
    email: 'leonor.vaz@example.com',
    status: UserStatus.Active,
    slug: 'leonor-vaz',
    firstName: 'Leonor',
    lastName: 'Vaz',
    pronouns: 'she/her',
    tagline: 'High school teacher',
    location: 'Porto',
    visibility: ProfileVisibility.Open,
    tags: ['Education'],
    openTo: [{ kind: 'preset', id: 'mentoring' }],
    verified: true,
    joinedAt: '2026-06-02T09:00:00.000Z',
  },
  {
    googleId: 'seed-vasco',
    email: 'vasco.marinho@example.com',
    status: UserStatus.Active,
    slug: 'vasco-marinho',
    firstName: 'Vasco',
    lastName: 'Marinho',
    pronouns: 'he/him',
    tagline: 'Carpenter, community garden lead',
    location: 'Setúbal',
    visibility: ProfileVisibility.Open,
    tags: ['Woodworking', 'Gardening'],
    openTo: [{ kind: 'preset', id: 'commissions' }],
    verified: false,
    joinedAt: '2026-07-03T09:00:00.000Z',
  },
  {
    googleId: 'seed-catarina',
    email: 'catarina.sequeira@example.com',
    status: UserStatus.Active,
    slug: 'catarina-sequeira',
    firstName: 'Catarina',
    lastName: 'Sequeira',
    pronouns: 'she/her',
    tagline: 'Nurse',
    location: 'Lisbon',
    visibility: ProfileVisibility.Network,
    tags: ['Health'],
    openTo: [{ kind: 'preset', id: 'casualMeetups' }],
    verified: false,
    joinedAt: '2026-05-12T09:00:00.000Z',
  },
  {
    googleId: 'seed-duarte',
    email: 'duarte.freitas@example.com',
    status: UserStatus.Active,
    slug: 'duarte-freitas',
    firstName: 'Duarte',
    lastName: 'Freitas',
    pronouns: 'he/him',
    tagline: 'Freelance photographer',
    location: 'Braga',
    visibility: ProfileVisibility.Open,
    tags: ['Photography'],
    openTo: [{ kind: 'preset', id: 'clientWork' }],
    verified: true,
    joinedAt: '2026-06-13T09:00:00.000Z',
  },
  {
    googleId: 'seed-renata',
    email: 'renata.salgado@example.com',
    status: UserStatus.Active,
    slug: 'renata-salgado',
    firstName: 'Renata',
    lastName: 'Salgado',
    pronouns: 'she/her',
    tagline: 'Bar manager',
    location: 'Porto',
    visibility: ProfileVisibility.Open,
    tags: ['Hospitality'],
    openTo: [{ kind: 'preset', id: 'casualMeetups' }],
    verified: false,
    joinedAt: '2026-06-09T09:00:00.000Z',
  },
  {
    googleId: 'seed-miguel',
    email: 'miguel.tavares@example.com',
    status: UserStatus.Active,
    slug: 'miguel-tavares',
    firstName: 'Miguel',
    lastName: 'Tavares',
    pronouns: 'he/him',
    tagline: 'Software QA',
    location: 'Lisbon',
    visibility: ProfileVisibility.Network,
    tags: ['Engineering', 'Games'],
    openTo: [{ kind: 'preset', id: 'referrals' }],
    verified: false,
    joinedAt: '2026-06-08T09:00:00.000Z',
  },
  {
    googleId: 'seed-ines',
    email: 'ines.barroso@example.com',
    status: UserStatus.Active,
    slug: 'ines-barroso',
    firstName: 'Inês',
    lastName: 'Barroso',
    pronouns: 'she/her',
    tagline: 'Midwife',
    location: 'Coimbra',
    visibility: ProfileVisibility.Open,
    tags: ['Health'],
    openTo: [{ kind: 'preset', id: 'mentoring' }],
    verified: true,
    joinedAt: '2026-05-21T09:00:00.000Z',
  },
  {
    googleId: 'seed-tiago',
    email: 'tiago.nogueira@example.com',
    status: UserStatus.Active,
    slug: 'tiago-nogueira',
    firstName: 'Tiago',
    lastName: 'Nogueira',
    pronouns: 'he/him',
    tagline: 'Union organizer',
    location: 'Lisbon',
    visibility: ProfileVisibility.Network,
    tags: ['Organizing', 'Advocacy'],
    openTo: [{ kind: 'preset', id: 'interviewees' }],
    verified: false,
    joinedAt: '2026-06-30T09:00:00.000Z',
  },
  // These 3 are the "joined in the last 7 days" cohort (see the note on the
  // interface above): unlike the 14 members above, whose vouch/report history
  // needs weeks of runway to spread over, these three are genuinely brand new
  // — a couple of very recent vouches each and no report history, which is
  // the realistic state for someone who joined days ago.
  {
    googleId: 'seed-nadia',
    email: 'nadia.ramos@example.com',
    status: UserStatus.Active,
    slug: 'nadia-ramos',
    firstName: 'Nádia',
    lastName: 'Ramos',
    pronouns: 'she/her',
    tagline: 'Illustrator, new to the city',
    location: 'Lisbon',
    visibility: ProfileVisibility.Open,
    tags: ['Illustration'],
    openTo: [{ kind: 'preset', id: 'casualMeetups' }],
    verified: false,
    joinedAt: '2026-07-19T09:00:00.000Z',
  },
  {
    googleId: 'seed-oscar',
    email: 'oscar.baptista@example.com',
    status: UserStatus.Active,
    slug: 'oscar-baptista',
    firstName: 'Óscar',
    lastName: 'Baptista',
    pronouns: 'he/him',
    tagline: 'Community-college student',
    location: 'Porto',
    visibility: ProfileVisibility.Network,
    tags: ['Student'],
    openTo: [{ kind: 'preset', id: 'casualMeetups' }],
    verified: false,
    joinedAt: '2026-07-17T09:00:00.000Z',
  },
  {
    googleId: 'seed-iris',
    email: 'iris.cabral@example.com',
    status: UserStatus.Active,
    slug: 'iris-cabral',
    firstName: 'Iris',
    lastName: 'Cabral',
    pronouns: 'they/she',
    tagline: 'Freelance translator',
    location: 'Braga',
    visibility: ProfileVisibility.Open,
    tags: ['Translation', 'Languages'],
    openTo: [{ kind: 'preset', id: 'clientWork' }],
    verified: false,
    joinedAt: '2026-07-15T09:00:00.000Z',
  },
];

// Representative communities for local frontend integration, owned by the
// seeded active members above (`tomas-mendes`, `ana-rocha`, `noa-silva`).
// Roster/author/reaction/reply slugs are resolved to userIds at seed time —
// see seedCommunities(). Spans ≥2 types and ≥2 access tiers, including one
// `public` and one `request` tier community; the `request` tier community
// carries a pending join-request from a member who is deliberately left off
// its roster.
interface CommunitySeedPost {
  authorSlug: string;
  body: string;
  kind: PostKind;
  pinned: boolean;
  reactions: Array<{ slug: string; key: ReactionKey }>;
  replies: Array<{ authorSlug: string; text: string }>;
}

interface CommunitySeedDefinition {
  ref: string;
  slug: string;
  name: string;
  purpose: string;
  type: CommunityType;
  whoFor: string;
  tagline: string;
  accessTier: AccessTier;
  rosterVisible: boolean;
  features: string[];
  rules: string[];
  ownerSlug: string;
  roster: Array<{ slug: string; role: RosterRole }>;
  posts: CommunitySeedPost[];
  pendingJoinRequest?: { slug: string; note: string | null };
}

const COMMUNITIES: CommunitySeedDefinition[] = [
  {
    ref: 'QP-C-0001',
    slug: 'queer-artists-lisbon',
    name: 'Queer Artists Lisbon',
    purpose:
      'A collective for queer visual artists, illustrators, and makers to share work, swap techniques, and find collaborators.',
    type: CommunityType.Arts,
    whoFor:
      'Queer artists, illustrators, and craftspeople in and around Lisbon.',
    tagline: 'Make queer art, together.',
    accessTier: AccessTier.Public,
    rosterVisible: true,
    features: ['discussion', 'events', 'library'],
    rules: ['Be kind, credit sources', 'No unsolicited critique'],
    ownerSlug: 'tomas-mendes',
    roster: [
      { slug: 'ana-rocha', role: RosterRole.Member },
      { slug: 'noa-silva', role: RosterRole.Member },
    ],
    posts: [
      {
        authorSlug: 'tomas-mendes',
        body: 'Welcome to Queer Artists Lisbon! Drop a link to something you made this month.',
        kind: PostKind.Announcement,
        pinned: true,
        reactions: [
          { slug: 'ana-rocha', key: ReactionKey.Heart },
          { slug: 'noa-silva', key: ReactionKey.Celebrate },
        ],
        replies: [
          {
            authorSlug: 'ana-rocha',
            text: 'So glad this exists, thank you Tomás!',
          },
        ],
      },
      {
        authorSlug: 'ana-rocha',
        body: 'Looking for a printmaker to collaborate on a zine about queer nightlife.',
        kind: PostKind.Post,
        pinned: false,
        reactions: [{ slug: 'tomas-mendes', key: ReactionKey.Fire }],
        replies: [
          {
            authorSlug: 'tomas-mendes',
            text: "I'm in, let's talk risograph.",
          },
          {
            authorSlug: 'noa-silva',
            text: 'Following this, would love to help curate.',
          },
        ],
      },
    ],
  },
  {
    ref: 'QP-C-0002',
    slug: 'sober-queers-porto',
    name: 'Sober Queers Porto',
    purpose:
      'Peer support space for queer folks navigating sobriety and recovery in Porto.',
    type: CommunityType.Support,
    whoFor:
      'Queer people who are sober, sober-curious, or supporting someone who is.',
    tagline: 'Recovery, together, out loud.',
    accessTier: AccessTier.Request,
    rosterVisible: false,
    features: ['discussion', 'rooms'],
    rules: [
      'Confidentiality stays in the room',
      'No judgment, no advice unless asked',
    ],
    ownerSlug: 'ana-rocha',
    roster: [{ slug: 'noa-silva', role: RosterRole.Mod }],
    posts: [
      {
        authorSlug: 'ana-rocha',
        body: 'Reminder: our Thursday check-in room opens at 19:00. All quiet, all welcome.',
        kind: PostKind.Announcement,
        pinned: true,
        reactions: [{ slug: 'noa-silva', key: ReactionKey.Support }],
        replies: [{ authorSlug: 'noa-silva', text: "I'll be there." }],
      },
      {
        authorSlug: 'noa-silva',
        body: '90 days today. Thank you all for holding space.',
        kind: PostKind.Post,
        pinned: false,
        reactions: [{ slug: 'ana-rocha', key: ReactionKey.Celebrate }],
        replies: [{ authorSlug: 'ana-rocha', text: 'So proud of you.' }],
      },
    ],
    // tomas-mendes is deliberately NOT on this community's roster — this is
    // the request-tier community's pending join-request.
    pendingJoinRequest: {
      slug: 'tomas-mendes',
      note: 'A friend recommended this group, would love to join and listen.',
    },
  },
  {
    ref: 'QP-C-0003',
    slug: 'queer-professionals-network',
    name: 'Queer Professionals Network',
    purpose:
      'A network for queer professionals to mentor, hire, and support each other across industries.',
    type: CommunityType.Professional,
    whoFor: 'Queer professionals, freelancers, and job-seekers.',
    tagline: 'Careers, without closets.',
    accessTier: AccessTier.Invite,
    rosterVisible: true,
    features: ['discussion', 'events', 'roster'],
    rules: ['No unsolicited pitches', 'Respect confidentiality of job leads'],
    ownerSlug: 'noa-silva',
    roster: [
      { slug: 'tomas-mendes', role: RosterRole.Member },
      { slug: 'ana-rocha', role: RosterRole.Member },
    ],
    posts: [
      {
        authorSlug: 'noa-silva',
        body: 'Posting a curator role at my gallery — DM me if illustration + editorial is your thing.',
        kind: PostKind.Announcement,
        pinned: true,
        reactions: [{ slug: 'tomas-mendes', key: ReactionKey.Fire }],
        replies: [
          { authorSlug: 'tomas-mendes', text: 'Sending you my portfolio!' },
        ],
      },
      {
        authorSlug: 'ana-rocha',
        body: 'Anyone have advice on pricing scoring work for indie games?',
        kind: PostKind.Post,
        pinned: false,
        reactions: [{ slug: 'noa-silva', key: ReactionKey.Heart }],
        replies: [],
      },
    ],
  },
  {
    ref: 'QP-C-0004',
    slug: 'queer-sports-braga',
    name: 'Queer Sports Braga',
    purpose:
      'Pickup games, hikes, and casual sport for queer folks of all fitness levels in Braga.',
    type: CommunityType.Sports,
    whoFor:
      'Queer people who want to move their bodies without the locker-room chill.',
    tagline: 'Sweat, not judgment.',
    accessTier: AccessTier.Public,
    rosterVisible: true,
    features: ['discussion', 'events'],
    rules: ['All fitness levels welcome', 'No outing teammates'],
    ownerSlug: 'tomas-mendes',
    roster: [
      { slug: 'ana-rocha', role: RosterRole.Mod },
      { slug: 'noa-silva', role: RosterRole.Member },
    ],
    posts: [
      {
        authorSlug: 'tomas-mendes',
        body: 'Sunday hike up to Sameiro, meet at the station at 9am.',
        kind: PostKind.Announcement,
        pinned: true,
        reactions: [
          { slug: 'ana-rocha', key: ReactionKey.Celebrate },
          { slug: 'noa-silva', key: ReactionKey.Fire },
        ],
        replies: [
          {
            authorSlug: 'ana-rocha',
            text: "Count me in, I'll bring snacks.",
          },
        ],
      },
      {
        authorSlug: 'ana-rocha',
        body: 'Started a casual five-a-side group, message me if you want in on the group chat.',
        kind: PostKind.Post,
        pinned: false,
        reactions: [{ slug: 'tomas-mendes', key: ReactionKey.Support }],
        replies: [],
      },
    ],
  },
];

/**
 * Idempotently seeds communities owned by the already-seeded active members.
 * `memberIdBySlug` maps a member's profile slug to their userId — callers
 * resolve it via the Profile repository before invoking this.
 */
async function seedCommunities(
  manager: EntityManager,
  memberIdBySlug: Map<string, string>,
): Promise<void> {
  const communities = manager.getRepository(Community);
  const communityMembers = manager.getRepository(CommunityMember);
  const posts = manager.getRepository(CommunityPost);
  const reactions = manager.getRepository(CommunityPostReaction);
  const replies = manager.getRepository(CommunityPostReply);
  const joinRequests = manager.getRepository(CommunityJoinRequest);

  const userId = (slug: string): string => {
    const id = memberIdBySlug.get(slug);
    if (!id) {
      throw new Error(
        `Cannot seed communities: no seeded member with slug "${slug}"`,
      );
    }
    return id;
  };

  for (const c of COMMUNITIES) {
    // Idempotent: skip if a community with this slug already exists.
    const existing = await communities.findOne({ where: { slug: c.slug } });
    if (existing) {
      continue;
    }

    const community = await communities.save(
      communities.create({
        slug: c.slug,
        name: c.name,
        purpose: c.purpose,
        type: c.type,
        whoFor: c.whoFor,
        tagline: c.tagline,
        accessTier: c.accessTier,
        rosterVisible: c.rosterVisible,
        features: c.features,
        rules: c.rules,
        ownerId: userId(c.ownerSlug),
        ref: c.ref,
      }),
    );

    await communityMembers.save(
      communityMembers.create({
        communityId: community.id,
        userId: userId(c.ownerSlug),
        role: RosterRole.Owner,
      }),
    );
    for (const r of c.roster) {
      await communityMembers.save(
        communityMembers.create({
          communityId: community.id,
          userId: userId(r.slug),
          role: r.role,
        }),
      );
    }

    for (const p of c.posts) {
      const post = await posts.save(
        posts.create({
          communityId: community.id,
          authorId: userId(p.authorSlug),
          body: p.body,
          image: null,
          kind: p.kind,
          pinned: p.pinned,
        }),
      );
      for (const reaction of p.reactions) {
        await reactions.save(
          reactions.create({
            postId: post.id,
            userId: userId(reaction.slug),
            key: reaction.key,
          }),
        );
      }
      for (const reply of p.replies) {
        await replies.save(
          replies.create({
            postId: post.id,
            authorId: userId(reply.authorSlug),
            text: reply.text,
          }),
        );
      }
    }

    if (c.pendingJoinRequest) {
      await joinRequests.save(
        joinRequests.create({
          communityId: community.id,
          userId: userId(c.pendingJoinRequest.slug),
          note: c.pendingJoinRequest.note,
          status: JoinRequestStatus.Pending,
        }),
      );
    }

    console.log(`Seeded community ${c.slug}`);
  }
}

// Task C1: attaches the 14 live-mode members (added to MEMBERS above) to the
// communities seeded above, with a couple of `mod` roles thrown in — so the
// admin drawer's communities section and card meta line have real data.
// Kept as its own idempotent pass (rather than folded into each
// `CommunitySeedDefinition.roster`) because `seedCommunities` skips a
// community entirely once it already exists, which would silently skip these
// roster rows on any re-run against a database seeded before this task.
interface LiveCommunityMembershipSeed {
  memberSlug: string;
  communitySlug: string;
  role: RosterRole;
}

const LIVE_COMMUNITY_MEMBERSHIPS: LiveCommunityMembershipSeed[] = [
  // Queer Artists Lisbon
  { memberSlug: 'beatriz-coelho', communitySlug: 'queer-artists-lisbon', role: RosterRole.Member },
  { memberSlug: 'diogo-antunes', communitySlug: 'queer-artists-lisbon', role: RosterRole.Mod },
  { memberSlug: 'rui-cardoso', communitySlug: 'queer-artists-lisbon', role: RosterRole.Member },
  { memberSlug: 'duarte-freitas', communitySlug: 'queer-artists-lisbon', role: RosterRole.Member },
  // Sober Queers Porto
  { memberSlug: 'marta-esteves', communitySlug: 'sober-queers-porto', role: RosterRole.Mod },
  { memberSlug: 'renata-salgado', communitySlug: 'sober-queers-porto', role: RosterRole.Member },
  { memberSlug: 'catarina-sequeira', communitySlug: 'sober-queers-porto', role: RosterRole.Member },
  // Queer Professionals Network
  { memberSlug: 'sofia-pinheiro', communitySlug: 'queer-professionals-network', role: RosterRole.Member },
  { memberSlug: 'leonor-vaz', communitySlug: 'queer-professionals-network', role: RosterRole.Mod },
  { memberSlug: 'ines-barroso', communitySlug: 'queer-professionals-network', role: RosterRole.Member },
  { memberSlug: 'tiago-nogueira', communitySlug: 'queer-professionals-network', role: RosterRole.Member },
  // Queer Sports Braga
  { memberSlug: 'kai-duarte', communitySlug: 'queer-sports-braga', role: RosterRole.Member },
  { memberSlug: 'vasco-marinho', communitySlug: 'queer-sports-braga', role: RosterRole.Mod },
  { memberSlug: 'miguel-tavares', communitySlug: 'queer-sports-braga', role: RosterRole.Member },
];

async function seedLiveCommunityMemberships(
  manager: EntityManager,
  memberIdBySlug: Map<string, string>,
): Promise<void> {
  const communities = manager.getRepository(Community);
  const communityMembers = manager.getRepository(CommunityMember);

  let insertedCount = 0;
  for (const membership of LIVE_COMMUNITY_MEMBERSHIPS) {
    const userId = memberIdBySlug.get(membership.memberSlug);
    if (!userId) {
      throw new Error(
        `Cannot seed live community membership: no seeded member with slug "${membership.memberSlug}"`,
      );
    }
    const community = await communities.findOne({
      where: { slug: membership.communitySlug },
    });
    if (!community) {
      throw new Error(
        `Cannot seed live community membership: no seeded community with slug "${membership.communitySlug}"`,
      );
    }

    // Idempotent: skip if this member is already on this community's roster.
    const existing = await communityMembers.findOne({
      where: { communityId: community.id, userId },
    });
    if (existing) {
      continue;
    }

    await communityMembers.save(
      communityMembers.create({
        communityId: community.id,
        userId,
        role: membership.role,
      }),
    );
    insertedCount += 1;
  }
  console.log(`Seeded ${insertedCount} live-mode community memberships`);
}

// Task C1: a connected vouch graph across every seeded member (the original 3
// plus the 17 live-mode members above) so the admin vouch graph and vouch
// feed have real data. Each member is vouched for by 2-12 others; two members
// (`diogo-antunes`, `ines-barroso`) are deliberately high-count hubs. The 3
// members who joined within the last 7 days (`nadia-ramos`, `oscar-baptista`,
// `iris-cabral`) deliberately have only a couple of very recent incoming
// vouches each and no deep history, since they haven't been members long
// enough to have accrued one.
// `createdAt` is a `@CreateDateColumn`, which TypeORM always overwrites with
// `new Date()` on insert (see `SubjectExecutor`) — so each row is saved first,
// then its `created_at` is set with a follow-up `repository.update()`, which
// goes through a plain `UpdateQueryBuilder` and (unlike `.save()`) never
// touches create-date columns, letting the explicit value stick.
interface VouchEdgeSeed {
  voucherSlug: string;
  voucheeSlug: string;
  daysAgo: number;
}

const VOUCH_EDGES: VouchEdgeSeed[] = [
  // Founding triangle
  { voucherSlug: 'tomas-mendes', voucheeSlug: 'ana-rocha', daysAgo: 60 },
  { voucherSlug: 'ana-rocha', voucheeSlug: 'noa-silva', daysAgo: 55 },
  { voucherSlug: 'noa-silva', voucheeSlug: 'tomas-mendes', daysAgo: 50 },
  // Founders vouching for one live-mode member each
  { voucherSlug: 'tomas-mendes', voucheeSlug: 'beatriz-coelho', daysAgo: 58 },
  { voucherSlug: 'ana-rocha', voucheeSlug: 'diogo-antunes', daysAgo: 3 },
  { voucherSlug: 'noa-silva', voucheeSlug: 'marta-esteves', daysAgo: 40 },
  { voucherSlug: 'tomas-mendes', voucheeSlug: 'rui-cardoso', daysAgo: 2 },
  { voucherSlug: 'ana-rocha', voucheeSlug: 'sofia-pinheiro', daysAgo: 45 },
  { voucherSlug: 'noa-silva', voucheeSlug: 'kai-duarte', daysAgo: 25 },
  { voucherSlug: 'tomas-mendes', voucheeSlug: 'leonor-vaz', daysAgo: 35 },
  { voucherSlug: 'ana-rocha', voucheeSlug: 'vasco-marinho', daysAgo: 4 },
  { voucherSlug: 'noa-silva', voucheeSlug: 'catarina-sequeira', daysAgo: 65 },
  { voucherSlug: 'tomas-mendes', voucheeSlug: 'duarte-freitas', daysAgo: 10 },
  { voucherSlug: 'ana-rocha', voucheeSlug: 'renata-salgado', daysAgo: 38 },
  { voucherSlug: 'noa-silva', voucheeSlug: 'miguel-tavares', daysAgo: 7 },
  { voucherSlug: 'tomas-mendes', voucheeSlug: 'ines-barroso', daysAgo: 48 },
  { voucherSlug: 'ana-rocha', voucheeSlug: 'tiago-nogueira', daysAgo: 18 },
  // Hub: diogo-antunes (12 vouchers total)
  { voucherSlug: 'tomas-mendes', voucheeSlug: 'diogo-antunes', daysAgo: 4 },
  { voucherSlug: 'noa-silva', voucheeSlug: 'diogo-antunes', daysAgo: 3 },
  { voucherSlug: 'beatriz-coelho', voucheeSlug: 'diogo-antunes', daysAgo: 20 },
  { voucherSlug: 'marta-esteves', voucheeSlug: 'diogo-antunes', daysAgo: 15 },
  { voucherSlug: 'rui-cardoso', voucheeSlug: 'diogo-antunes', daysAgo: 1 },
  { voucherSlug: 'sofia-pinheiro', voucheeSlug: 'diogo-antunes', daysAgo: 22 },
  { voucherSlug: 'kai-duarte', voucheeSlug: 'diogo-antunes', daysAgo: 12 },
  { voucherSlug: 'leonor-vaz', voucheeSlug: 'diogo-antunes', daysAgo: 17 },
  { voucherSlug: 'vasco-marinho', voucheeSlug: 'diogo-antunes', daysAgo: 3 },
  { voucherSlug: 'catarina-sequeira', voucheeSlug: 'diogo-antunes', daysAgo: 30 },
  { voucherSlug: 'duarte-freitas', voucheeSlug: 'diogo-antunes', daysAgo: 6 },
  // Hub: ines-barroso (10 vouchers total)
  { voucherSlug: 'ana-rocha', voucheeSlug: 'ines-barroso', daysAgo: 33 },
  { voucherSlug: 'noa-silva', voucheeSlug: 'ines-barroso', daysAgo: 28 },
  { voucherSlug: 'diogo-antunes', voucheeSlug: 'ines-barroso', daysAgo: 9 },
  { voucherSlug: 'marta-esteves', voucheeSlug: 'ines-barroso', daysAgo: 14 },
  { voucherSlug: 'sofia-pinheiro', voucheeSlug: 'ines-barroso', daysAgo: 11 },
  { voucherSlug: 'kai-duarte', voucheeSlug: 'ines-barroso', daysAgo: 8 },
  { voucherSlug: 'vasco-marinho', voucheeSlug: 'ines-barroso', daysAgo: 6 },
  { voucherSlug: 'renata-salgado', voucheeSlug: 'ines-barroso', daysAgo: 13 },
  { voucherSlug: 'miguel-tavares', voucheeSlug: 'ines-barroso', daysAgo: 5 },
  // Remaining cross-vouches (each brings a member to 3+ incoming vouches)
  { voucherSlug: 'sofia-pinheiro', voucheeSlug: 'beatriz-coelho', daysAgo: 26 },
  { voucherSlug: 'leonor-vaz', voucheeSlug: 'beatriz-coelho', daysAgo: 19 },
  { voucherSlug: 'vasco-marinho', voucheeSlug: 'rui-cardoso', daysAgo: 2 },
  { voucherSlug: 'diogo-antunes', voucheeSlug: 'rui-cardoso', daysAgo: 1 },
  { voucherSlug: 'beatriz-coelho', voucheeSlug: 'sofia-pinheiro', daysAgo: 24 },
  { voucherSlug: 'catarina-sequeira', voucheeSlug: 'sofia-pinheiro', daysAgo: 36 },
  { voucherSlug: 'beatriz-coelho', voucheeSlug: 'leonor-vaz', daysAgo: 21 },
  { voucherSlug: 'renata-salgado', voucheeSlug: 'leonor-vaz', daysAgo: 16 },
  { voucherSlug: 'rui-cardoso', voucheeSlug: 'vasco-marinho', daysAgo: 3 },
  { voucherSlug: 'tiago-nogueira', voucheeSlug: 'vasco-marinho', daysAgo: 9 },
  { voucherSlug: 'duarte-freitas', voucheeSlug: 'catarina-sequeira', daysAgo: 12 },
  { voucherSlug: 'marta-esteves', voucheeSlug: 'catarina-sequeira', daysAgo: 44 },
  { voucherSlug: 'miguel-tavares', voucheeSlug: 'duarte-freitas', daysAgo: 6 },
  { voucherSlug: 'renata-salgado', voucheeSlug: 'duarte-freitas', daysAgo: 11 },
  { voucherSlug: 'catarina-sequeira', voucheeSlug: 'renata-salgado', daysAgo: 14 },
  { voucherSlug: 'tiago-nogueira', voucheeSlug: 'renata-salgado', daysAgo: 7 },
  { voucherSlug: 'kai-duarte', voucheeSlug: 'miguel-tavares', daysAgo: 10 },
  { voucherSlug: 'duarte-freitas', voucheeSlug: 'miguel-tavares', daysAgo: 5 },
  { voucherSlug: 'leonor-vaz', voucheeSlug: 'tiago-nogueira', daysAgo: 13 },
  { voucherSlug: 'vasco-marinho', voucheeSlug: 'tiago-nogueira', daysAgo: 8 },
  { voucherSlug: 'rui-cardoso', voucheeSlug: 'marta-esteves', daysAgo: 16 },
  { voucherSlug: 'kai-duarte', voucheeSlug: 'marta-esteves', daysAgo: 23 },
  { voucherSlug: 'marta-esteves', voucheeSlug: 'kai-duarte', daysAgo: 27 },
  { voucherSlug: 'miguel-tavares', voucheeSlug: 'kai-duarte', daysAgo: 14 },
  { voucherSlug: 'diogo-antunes', voucheeSlug: 'tomas-mendes', daysAgo: 5 },
  { voucherSlug: 'beatriz-coelho', voucheeSlug: 'tomas-mendes', daysAgo: 42 },
  { voucherSlug: 'ines-barroso', voucheeSlug: 'ana-rocha', daysAgo: 31 },
  { voucherSlug: 'sofia-pinheiro', voucheeSlug: 'ana-rocha', daysAgo: 29 },
  { voucherSlug: 'kai-duarte', voucheeSlug: 'noa-silva', daysAgo: 34 },
  { voucherSlug: 'marta-esteves', voucheeSlug: 'noa-silva', daysAgo: 37 },
  // The "joined in the last 7 days" cohort: a couple of very recent vouches
  // each, all comfortably within their own short tenure.
  { voucherSlug: 'tomas-mendes', voucheeSlug: 'nadia-ramos', daysAgo: 1 },
  { voucherSlug: 'beatriz-coelho', voucheeSlug: 'nadia-ramos', daysAgo: 1 },
  { voucherSlug: 'ana-rocha', voucheeSlug: 'oscar-baptista', daysAgo: 2 },
  { voucherSlug: 'diogo-antunes', voucheeSlug: 'oscar-baptista', daysAgo: 1 },
  { voucherSlug: 'noa-silva', voucheeSlug: 'iris-cabral', daysAgo: 3 },
  { voucherSlug: 'marta-esteves', voucheeSlug: 'iris-cabral', daysAgo: 2 },
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function seedVouches(
  manager: EntityManager,
  memberIdBySlug: Map<string, string>,
): Promise<void> {
  const vouches = manager.getRepository(Vouch);
  const now = Date.now();

  const userId = (slug: string): string => {
    const id = memberIdBySlug.get(slug);
    if (!id) {
      throw new Error(`Cannot seed vouches: no seeded member with slug "${slug}"`);
    }
    return id;
  };

  let insertedCount = 0;
  for (const edge of VOUCH_EDGES) {
    const voucherId = userId(edge.voucherSlug);
    const voucheeId = userId(edge.voucheeSlug);

    // Idempotent: skip if this (voucher, vouchee) pair already exists.
    const existing = await vouches.findOne({ where: { voucherId, voucheeId } });
    if (existing) {
      continue;
    }

    const saved = await vouches.save(
      vouches.create({ voucherId, voucheeId, note: null }),
    );
    const createdAt = new Date(now - edge.daysAgo * MS_PER_DAY);
    await vouches.update({ id: saved.id }, { createdAt });
    insertedCount += 1;
  }
  console.log(`Seeded ${insertedCount} vouches`);
}

// Task C1: ~10 reports against seeded members so the admin flagged tab, vouch
// graph deemphasis, reasonCode breakdown, and response-time chart all have
// real data. `subjectType` is always `Member` and `subjectId` is the
// reported member's profile slug (moderation's `resolveMemberSubject` checks
// `{ slug: subjectId }` for any non-UUID subjectId, so a slug round-trips
// correctly). Only reason codes `reasonsFor(ReportSubjectType.Member)`
// actually offers are used (outing, harassment, unwanted_contact,
// impersonation, discrimination, other) — the brief's "spam"/"hate_speech"
// examples are Post/Community-only reasons per `reason-catalogue.ts` and
// would misrepresent what a member-report can carry, so they're intentionally
// left out here. `doxxing` (also Member-eligible) is left out too: it's
// emergency-severity like `outing`, and the brief calls for exactly one
// emergency report.
interface ReportResolutionSeed {
  actorSlug: string;
  action: ModActionCode;
  resolutionReasonCode: ReasonCode;
  note: string;
  duration?: string;
  hoursAfter: number;
}

interface ReportSeed {
  targetSlug: string;
  reporterSlug: string;
  reasonCode: ReasonCode;
  detail: string;
  daysAgo: number;
  status: ReportStatus;
  resolution?: ReportResolutionSeed;
}

const REPORTS: ReportSeed[] = [
  // Flagged pair, left Open: diogo-antunes (2 open reports)
  {
    targetSlug: 'diogo-antunes',
    reporterSlug: 'beatriz-coelho',
    reasonCode: 'outing',
    detail: 'Shared a screenshot outing another member’s legal name in a group chat.',
    daysAgo: 50,
    status: ReportStatus.Open,
  },
  {
    targetSlug: 'diogo-antunes',
    reporterSlug: 'sofia-pinheiro',
    reasonCode: 'harassment',
    detail: 'Repeated pointed comments after being asked to stop.',
    daysAgo: 45,
    status: ReportStatus.Open,
  },
  // Flagged pair, left Open: miguel-tavares (2 open reports)
  {
    targetSlug: 'miguel-tavares',
    reporterSlug: 'catarina-sequeira',
    reasonCode: 'discrimination',
    detail: 'Made a dismissive comment about a member’s pronouns in a community post.',
    daysAgo: 40,
    status: ReportStatus.Open,
  },
  {
    targetSlug: 'miguel-tavares',
    reporterSlug: 'duarte-freitas',
    reasonCode: 'impersonation',
    detail: 'Appears to be using another member’s photos on an off-platform profile.',
    daysAgo: 35,
    status: ReportStatus.Open,
  },
  // One more Open report, not part of either flagged pair
  {
    targetSlug: 'vasco-marinho',
    reporterSlug: 'tiago-nogueira',
    reasonCode: 'unwanted_contact',
    detail: 'Kept messaging after being told to stop.',
    daysAgo: 8,
    status: ReportStatus.Open,
  },
  // Resolved, each with a matching resolving ModAuditLog
  {
    targetSlug: 'rui-cardoso',
    reporterSlug: 'leonor-vaz',
    reasonCode: 'harassment',
    detail: 'Sent aggressive DMs after a disagreement in a community thread.',
    daysAgo: 30,
    status: ReportStatus.Resolved,
    resolution: {
      actorSlug: 'noa-silva',
      action: 'warn',
      resolutionReasonCode: 'harassment',
      note: 'Formal warning issued; member acknowledged and apologized.',
      hoursAfter: 30,
    },
  },
  {
    targetSlug: 'kai-duarte',
    reporterSlug: 'marta-esteves',
    reasonCode: 'other',
    detail: 'Made the reporter uncomfortable at a meetup; hard to pin to one category.',
    daysAgo: 25,
    status: ReportStatus.Resolved,
    resolution: {
      actorSlug: 'ana-rocha',
      action: 'dismiss',
      resolutionReasonCode: 'other',
      note: 'Reviewed with both members; no policy violation found.',
      hoursAfter: 72,
    },
  },
  {
    targetSlug: 'renata-salgado',
    reporterSlug: 'ines-barroso',
    reasonCode: 'unwanted_contact',
    detail: 'Continued contacting the reporter across two communities after being asked to stop.',
    daysAgo: 20,
    status: ReportStatus.Resolved,
    resolution: {
      actorSlug: 'noa-silva',
      action: 'restrict',
      resolutionReasonCode: 'unwanted_contact',
      note: 'Messaging restricted for 7 days pending a check-in.',
      duration: '7d',
      hoursAfter: 6,
    },
  },
  {
    targetSlug: 'leonor-vaz',
    reporterSlug: 'vasco-marinho',
    reasonCode: 'discrimination',
    detail: 'Misgendered a member repeatedly after being corrected.',
    daysAgo: 15,
    status: ReportStatus.Resolved,
    resolution: {
      actorSlug: 'ana-rocha',
      action: 'warn',
      resolutionReasonCode: 'discrimination',
      note: 'Warned about repeated misgendering; member committed to doing better.',
      hoursAfter: 48,
    },
  },
  {
    targetSlug: 'beatriz-coelho',
    reporterSlug: 'noa-silva',
    reasonCode: 'harassment',
    detail: 'Escalating public callouts of another member across two community threads.',
    daysAgo: 10,
    status: ReportStatus.Resolved,
    resolution: {
      actorSlug: 'tomas-mendes',
      action: 'suspend',
      resolutionReasonCode: 'harassment',
      note: 'Suspended for a week after a second escalation despite an earlier warning.',
      duration: '7d',
      hoursAfter: 20,
    },
  },
];

async function seedReports(
  manager: EntityManager,
  memberIdBySlug: Map<string, string>,
): Promise<void> {
  const reports = manager.getRepository(Report);
  const modAuditLogs = manager.getRepository(ModAuditLog);
  const now = Date.now();

  const userId = (slug: string): string => {
    const id = memberIdBySlug.get(slug);
    if (!id) {
      throw new Error(`Cannot seed reports: no seeded member with slug "${slug}"`);
    }
    return id;
  };

  let insertedReportCount = 0;
  let insertedAuditLogCount = 0;
  for (const r of REPORTS) {
    const reporterId = userId(r.reporterSlug);

    // Idempotent: skip if this reporter already filed this exact reasonCode
    // against this subject (a real reporter could file more than one report
    // against the same member over time, but never twice with the same
    // reason — that's the natural key here since there's no other unique
    // constraint to key off).
    const existing = await reports.findOne({
      where: {
        subjectType: ReportSubjectType.Member,
        subjectId: r.targetSlug,
        reasonCode: r.reasonCode,
        reporterId,
      },
    });
    if (existing) {
      continue;
    }

    const createdAt = new Date(now - r.daysAgo * MS_PER_DAY);
    const severity = deriveSeverity(r.reasonCode);

    const saved = await reports.save(
      reports.create({
        subjectType: ReportSubjectType.Member,
        subjectId: r.targetSlug,
        reasonCode: r.reasonCode,
        detail: r.detail,
        severity,
        slaDueAt: slaDueAtFor(severity, createdAt),
        status: r.status,
        reporterId,
      }),
    );
    // createdAt is a `@CreateDateColumn` — see the comment above VOUCH_EDGES
    // for why this needs a follow-up `.update()` rather than being set here.
    await reports.update({ id: saved.id }, { createdAt });
    insertedReportCount += 1;

    if (r.resolution) {
      const auditLog = await modAuditLogs.save(
        modAuditLogs.create({
          reportId: saved.id,
          actorId: userId(r.resolution.actorSlug),
          action: r.resolution.action,
          reasonCode: r.resolution.resolutionReasonCode,
          note: r.resolution.note,
          duration: r.resolution.duration ?? null,
        }),
      );
      const resolvedAt = new Date(
        createdAt.getTime() + r.resolution.hoursAfter * 60 * 60 * 1000,
      );
      await modAuditLogs.update({ id: auditLog.id }, { createdAt: resolvedAt });
      insertedAuditLogCount += 1;
    }
  }
  console.log(
    `Seeded ${insertedReportCount} reports (${insertedAuditLogCount} resolved with a matching mod audit log)`,
  );
}

// Representative companies for local frontend integration, owned by the
// seeded active members above (`tomas-mendes`, `ana-rocha`, `noa-silva`).
// Owner/team/reviewer slugs are resolved to userIds at seed time — see
// seedCompanies(). `teamCount` is derived from the actual seeded
// `company_team_members` rows, mirroring `CompaniesService.createWithUniqueSlug`.
interface CompanyReviewSeed {
  authorSlug: string;
  title: string;
  stars: number;
  byline: string;
  body: string[];
}

interface CompanySeedDefinition {
  slug: string;
  nameText: string;
  tagline: string;
  about: string;
  queerRun: boolean;
  queerLed: boolean;
  values: CompanyValue[];
  info: CompanyInfoItem[];
  work: CompanyWorkItem[];
  hiringContact: CompanyHiringContact | null;
  ownerSlug: string;
  team: string[]; // member slugs, besides the owner
  reviews: CompanyReviewSeed[];
}

const COMPANIES: CompanySeedDefinition[] = [
  {
    slug: 'atelier-pulso',
    nameText: 'Atelier Pulso',
    tagline: 'A queer-run illustration and print studio.',
    about:
      'Atelier Pulso is a small design studio making risograph zines, editorial illustration, and cover art for queer community projects across Lisbon.',
    queerRun: true,
    queerLed: true,
    values: [
      {
        title: 'Community first',
        desc: 'We prioritize queer clients and collaborators.',
      },
      { title: 'Slow craft', desc: 'We take the time print deserves.' },
    ],
    info: [
      { label: 'Founded', value: '2021' },
      { label: 'Size', value: '2-10 people' },
      { label: 'HQ', value: 'Lisbon, Portugal' },
    ],
    work: [{ label: 'Zine covers for local collectives', imageUrl: null }],
    hiringContact: { name: 'Tomás Mendes', role: 'Founder' },
    ownerSlug: 'tomas-mendes',
    team: ['ana-rocha'],
    reviews: [
      {
        authorSlug: 'ana-rocha',
        title: 'Genuinely lovely place to make things',
        stars: 5,
        byline: 'Collaborator',
        body: ['Every project feels like a conversation, not a brief.'],
      },
      {
        authorSlug: 'noa-silva',
        title: 'Great eye for print',
        stars: 4,
        byline: 'Client',
        body: ['The risograph work they did for us was gorgeous.'],
      },
    ],
  },
  {
    slug: 'queerpulse',
    nameText: 'QueerPulse',
    tagline: 'The invite-only platform behind this whole thing.',
    about:
      'QueerPulse builds community infrastructure — profiles, vouching, events, and messaging — for queer communities that want their own space.',
    queerRun: true,
    queerLed: true,
    values: [
      {
        title: 'Consent by design',
        desc: 'Invite-only, vouch-gated, opt-in visibility.',
      },
      {
        title: 'Community-owned',
        desc: 'Built with and for the people who use it.',
      },
    ],
    info: [
      { label: 'Founded', value: '2025' },
      { label: 'Size', value: '2-10 people' },
      { label: 'HQ', value: 'Remote-first' },
    ],
    work: [{ label: 'The platform itself', imageUrl: null }],
    hiringContact: { name: 'Noa Silva', role: 'Product' },
    ownerSlug: 'noa-silva',
    team: ['tomas-mendes', 'ana-rocha'],
    reviews: [
      {
        authorSlug: 'tomas-mendes',
        title: 'Finally, a platform that gets it',
        stars: 5,
        byline: 'Early member',
        body: [
          'The vouching flow feels safe in a way most apps never bother with.',
        ],
      },
      {
        authorSlug: 'ana-rocha',
        title: 'Great team to build alongside',
        stars: 5,
        byline: 'Contributor',
        body: ['Thoughtful about privacy from day one.'],
      },
    ],
  },
  {
    slug: 'ilga-portugal',
    nameText: 'ILGA Portugal',
    tagline: 'Advocacy and support for LGBTI+ rights in Portugal.',
    about:
      'ILGA Portugal is a longstanding association working on legal advocacy, community support services, and public education for LGBTI+ people across the country.',
    queerRun: false,
    queerLed: true,
    values: [
      {
        title: 'Rights, not favors',
        desc: 'Legal and policy advocacy at the core.',
      },
      {
        title: 'Support without judgment',
        desc: 'Free, confidential peer support services.',
      },
    ],
    info: [
      { label: 'Founded', value: '1995' },
      { label: 'Size', value: '11-50 people' },
      { label: 'HQ', value: 'Lisbon, Portugal' },
    ],
    work: [{ label: 'Annual LGBTI+ rights report', imageUrl: null }],
    hiringContact: { name: 'Ana Rocha', role: 'Volunteer Coordinator' },
    ownerSlug: 'ana-rocha',
    team: ['noa-silva'],
    reviews: [
      {
        authorSlug: 'tomas-mendes',
        title: 'Vital work, done with care',
        stars: 5,
        byline: 'Volunteer',
        body: ['The support line trained me well and never rushed a caller.'],
      },
      {
        authorSlug: 'noa-silva',
        title: 'Meaningful, if under-resourced',
        stars: 4,
        byline: 'Former intern',
        body: ['Everyone here is stretched thin but shows up anyway.'],
      },
    ],
  },
  {
    slug: 'opus-diversus',
    nameText: 'Opus Diversus',
    tagline: 'Inclusive consulting for arts organizations.',
    about:
      'Opus Diversus advises arts and cultural institutions on inclusive programming, accessibility, and diversity in hiring and curation.',
    queerRun: false,
    queerLed: false,
    values: [
      {
        title: 'Evidence over optics',
        desc: 'Measured outcomes, not just statements.',
      },
      {
        title: 'Long-term partnership',
        desc: 'We stay past the first workshop.',
      },
    ],
    info: [
      { label: 'Founded', value: '2018' },
      { label: 'Size', value: '11-50 people' },
      { label: 'HQ', value: 'Porto, Portugal' },
    ],
    work: [{ label: 'Inclusive curation playbook', imageUrl: null }],
    hiringContact: { name: 'Noa Silva', role: 'Engagements Lead' },
    ownerSlug: 'tomas-mendes',
    team: [],
    reviews: [
      {
        authorSlug: 'ana-rocha',
        title: 'Solid, if a bit slow-moving',
        stars: 3,
        byline: 'Partner org staff',
        body: [
          'Good recommendations, took a while to get momentum internally.',
        ],
      },
      {
        authorSlug: 'noa-silva',
        title: 'Changed how we hire curators',
        stars: 4,
        byline: 'Gallery director',
        body: ['Their audit was uncomfortable and exactly what we needed.'],
      },
    ],
  },
  {
    slug: 'livraria-devagar',
    nameText: 'Livraria Devagar',
    tagline: 'A queer-run independent bookshop.',
    about:
      'Livraria Devagar is a small independent bookshop specializing in queer literature, zines, and community events — readings, book clubs, and swap shelves.',
    queerRun: true,
    queerLed: true,
    values: [
      {
        title: 'Slow reading',
        desc: 'A shop built for browsing, not just buying.',
      },
      {
        title: 'Local first',
        desc: 'We stock small and self-published presses.',
      },
    ],
    info: [
      { label: 'Founded', value: '2019' },
      { label: 'Size', value: '2-10 people' },
      { label: 'HQ', value: 'Braga, Portugal' },
    ],
    work: [{ label: 'Monthly queer book club', imageUrl: null }],
    hiringContact: { name: 'Noa Silva', role: 'Owner' },
    ownerSlug: 'noa-silva',
    team: ['tomas-mendes'],
    reviews: [
      {
        authorSlug: 'tomas-mendes',
        title: 'My favourite shop in the city',
        stars: 5,
        byline: 'Regular',
        body: ['The staff picks shelf alone is worth the visit.'],
      },
      {
        authorSlug: 'ana-rocha',
        title: 'Wonderful book club',
        stars: 5,
        byline: 'Book club member',
        body: ['Warm space, great discussions every month.'],
      },
    ],
  },
];

/**
 * Idempotently seeds companies owned by the already-seeded active members.
 * `memberIdBySlug` maps a member's profile slug to their userId — mirrors
 * `seedCommunities`'s identical precedent.
 */
async function seedCompanies(
  manager: EntityManager,
  memberIdBySlug: Map<string, string>,
): Promise<void> {
  const companies = manager.getRepository(Company);
  const companyTeamMembers = manager.getRepository(CompanyTeamMember);
  const companyReviews = manager.getRepository(CompanyReview);

  const userId = (slug: string): string => {
    const id = memberIdBySlug.get(slug);
    if (!id) {
      throw new Error(
        `Cannot seed companies: no seeded member with slug "${slug}"`,
      );
    }
    return id;
  };

  for (const c of COMPANIES) {
    // Idempotent: skip if a company with this slug already exists.
    const existing = await companies.findOne({ where: { slug: c.slug } });
    if (existing) {
      continue;
    }

    const company = await companies.save(
      companies.create({
        slug: c.slug,
        nameText: c.nameText,
        tagline: c.tagline,
        about: c.about,
        queerRun: c.queerRun,
        queerLed: c.queerLed,
        // Admin-only; never set true from a seed/API payload.
        verified: false,
        values: c.values,
        info: c.info,
        teamCount: c.team.length,
        hiringContact: c.hiringContact,
        work: c.work,
        ownerId: userId(c.ownerSlug),
      }),
    );

    for (const memberSlug of c.team) {
      await companyTeamMembers.save(
        companyTeamMembers.create({
          companyId: company.id,
          userId: userId(memberSlug),
        }),
      );
    }

    for (const review of c.reviews) {
      await companyReviews.save(
        companyReviews.create({
          companyId: company.id,
          authorId: userId(review.authorSlug),
          title: review.title,
          stars: review.stars,
          byline: review.byline,
          body: review.body,
        }),
      );
    }

    console.log(`Seeded company ${c.slug}`);
  }
}

// Representative jobs for local frontend integration, each FK'd to one of the
// seeded companies above and posted by that company's owner. Company/poster
// slugs are resolved to ids/userIds at seed time — see seedJobs().
interface JobSeedDefinition {
  slug: string;
  companySlug: string;
  posterSlug: string;
  title: string;
  category: string;
  commitment: string;
  seniority: string;
  format: JobFormat;
  location: string;
  city: string | null;
  timezone: string | null;
  salary: string | null;
  rateMin: number | null;
  rateMax: number | null;
  currency: string | null;
  ratePer: string | null;
  hidePay: boolean;
  barter: boolean;
  deadline: string | null;
  startDate: string | null;
  desc: string;
  tags: string[];
  queerRun: boolean;
  qrLabel: string | null;
  detail: JobDetailBody;
  benefits: string[];
  inclusivity: string[];
  screening: string[];
  contacts: string[];
  email: string | null;
  link: string | null;
  status: JobStatus;
}

const JOBS: JobSeedDefinition[] = [
  {
    slug: 'junior-graphic-designer',
    companySlug: 'atelier-pulso',
    posterSlug: 'tomas-mendes',
    title: 'Junior Graphic Designer',
    category: 'Design',
    commitment: 'Full-time',
    seniority: 'Junior',
    format: JobFormat.Hybrid,
    location: 'Lisbon, Portugal',
    city: 'Lisbon',
    timezone: 'Europe/Lisbon',
    salary: '€22k–26k / year',
    rateMin: 22000,
    rateMax: 26000,
    currency: 'EUR',
    ratePer: 'year',
    hidePay: false,
    barter: false,
    deadline: '2026-08-15',
    startDate: '2026-09-01',
    desc: 'Help our small studio bring risograph zines and community print projects to life.',
    tags: ['Illustration', 'Print', 'Risograph'],
    queerRun: true,
    qrLabel: 'Queer-run studio',
    detail: {
      about: [
        'Atelier Pulso is a small design studio making risograph zines, editorial illustration, and cover art for queer community projects across Lisbon.',
        "We're growing from two people to three, and want someone who loves print as much as we do.",
      ],
      dayToDay: [
        'Prep files and separations for risograph printing',
        'Illustrate covers and spreads for client zines',
        'Sit in on client calls and take briefs',
      ],
      lookingFor: [
        '1-2 years of illustration or print design experience (a portfolio, not a degree, is what matters)',
        'Comfort with Lisbon-based, in-person studio days a few times a week',
      ],
      offer: [
        'Mentorship from a founder with 10+ years in community print',
        'A studio that already prioritizes queer clients and collaborators',
        'Real client-facing responsibility from week one',
      ],
      reviewerNote: 'Tomás reviews every application personally within a week.',
    },
    benefits: ['Flexible hours', 'Print materials budget', 'Studio access'],
    inclusivity: [
      'Pronouns respected by default',
      'Flexible around gender-affirming care appointments',
    ],
    screening: ['Portfolio review', 'Studio visit chat'],
    contacts: ['Tomás Mendes, Founder'],
    email: 'jobs@atelierpulso.example.com',
    link: null,
    status: JobStatus.Open,
  },
  {
    slug: 'community-outreach-coordinator',
    companySlug: 'ilga-portugal',
    posterSlug: 'ana-rocha',
    title: 'Community Outreach Coordinator',
    category: 'Community & Advocacy',
    commitment: 'Full-time',
    seniority: 'Mid',
    format: JobFormat.InPerson,
    location: 'Lisbon, Portugal',
    city: 'Lisbon',
    timezone: 'Europe/Lisbon',
    salary: '€1,400–1,700 / month',
    rateMin: 1400,
    rateMax: 1700,
    currency: 'EUR',
    ratePer: 'month',
    hidePay: false,
    barter: false,
    deadline: '2026-09-01',
    startDate: '2026-10-01',
    desc: 'Build relationships with LGBTI+ community groups across the country and coordinate outreach events.',
    tags: ['Advocacy', 'Community', 'Events'],
    queerRun: false,
    qrLabel: null,
    detail: {
      about: [
        'ILGA Portugal is a longstanding association working on legal advocacy, community support services, and public education for LGBTI+ people across the country.',
      ],
      dayToDay: [
        'Coordinate with community groups and volunteers outside Lisbon',
        'Plan and run outreach events, workshops, and info sessions',
        'Track outreach outcomes and report to the programmes team',
      ],
      lookingFor: [
        'Experience organizing events or working with community groups',
        'Comfort traveling within Portugal for outreach visits',
      ],
      offer: [
        "A role at the center of the country's oldest LGBTI+ rights organization",
        'Training in advocacy and public-facing community work',
      ],
      reviewerNote: null,
    },
    benefits: ['Travel stipend', 'Meal allowance'],
    inclusivity: [
      'Confidential HR line',
      'Flexible around Pride season travel',
    ],
    screening: ['Phone screen', 'Panel interview'],
    contacts: ['Ana Rocha, Volunteer Coordinator'],
    email: 'jobs@ilga-portugal.example.com',
    link: null,
    status: JobStatus.Open,
  },
  {
    slug: 'backend-engineer',
    companySlug: 'queerpulse',
    posterSlug: 'noa-silva',
    title: 'Backend Engineer',
    category: 'Engineering',
    commitment: 'Full-time',
    seniority: 'Senior',
    format: JobFormat.Remote,
    location: 'Remote (Portugal-based preferred)',
    city: null,
    timezone: 'Europe/Lisbon',
    salary: null,
    rateMin: 45000,
    rateMax: 60000,
    currency: 'EUR',
    ratePer: 'year',
    hidePay: true,
    barter: false,
    deadline: null,
    startDate: '2026-08-01',
    desc: 'Build the backend that powers vouching, connections, and messaging for queer communities.',
    tags: ['NestJS', 'TypeScript', 'PostgreSQL'],
    queerRun: true,
    qrLabel: 'Queer-run team',
    detail: {
      about: [
        'QueerPulse builds community infrastructure — profiles, vouching, events, and messaging — for queer communities that want their own space.',
      ],
      dayToDay: [
        'Design and ship features across the NestJS/TypeORM backend',
        'Pair on privacy- and consent-sensitive features like vouching and connections',
        'Review PRs and help keep the migration-owned schema honest',
      ],
      lookingFor: [
        '3+ years building production backend services',
        'Comfort with PostgreSQL, TypeORM (or a similar data-mapper ORM), and REST APIs',
        'Care about privacy-by-design, not just as a checkbox',
      ],
      offer: [
        'A small, fully remote, queer-run team',
        'Direct input into product direction, not just ticket execution',
      ],
      reviewerNote:
        'Compensation is negotiable based on experience — reach out even if the range feels off.',
    },
    benefits: ['Fully remote', 'Flexible hours', 'Learning budget'],
    inclusivity: [
      'Team pronouns shared by default',
      'Flexible around gender-affirming care and family leave',
    ],
    screening: ['Take-home exercise', 'Pairing session', 'Team chat'],
    contacts: ['Noa Silva, Product'],
    email: 'jobs@queerpulse.example.com',
    link: 'https://queerpulse.example.com/careers/backend-engineer',
    status: JobStatus.Open,
  },
  {
    slug: 'programme-coordinator',
    companySlug: 'opus-diversus',
    posterSlug: 'tomas-mendes',
    title: 'Programme Coordinator',
    category: 'Programme & Operations',
    commitment: 'Part-time',
    seniority: 'Mid',
    format: JobFormat.Hybrid,
    location: 'Porto, Portugal',
    city: 'Porto',
    timezone: 'Europe/Lisbon',
    salary: '€900–1,100 / month',
    rateMin: 900,
    rateMax: 1100,
    currency: 'EUR',
    ratePer: 'month',
    hidePay: false,
    barter: false,
    deadline: '2026-08-30',
    startDate: null,
    desc: 'Coordinate inclusive-programming engagements with arts and cultural institutions.',
    tags: ['Arts', 'Inclusion', 'Project management'],
    queerRun: false,
    qrLabel: null,
    detail: {
      about: [
        'Opus Diversus advises arts and cultural institutions on inclusive programming, accessibility, and diversity in hiring and curation.',
      ],
      dayToDay: [
        'Coordinate engagement timelines with partner institutions',
        'Prepare workshop materials and accessibility audits',
        'Track engagement outcomes for the annual report',
      ],
      lookingFor: [
        'Experience in arts administration or project coordination',
        'Interest in accessibility and inclusive curation practices',
      ],
      offer: [
        'Part-time flexibility',
        'Exposure across multiple partner institutions',
      ],
      reviewerNote: null,
    },
    benefits: ['Flexible hours', 'Travel expenses covered'],
    inclusivity: [
      'Accessible offices in Porto',
      'Remote-friendly for most tasks',
    ],
    screening: ['Portfolio/CV review', 'Interview'],
    contacts: ['Noa Silva, Engagements Lead'],
    email: null,
    link: 'https://opusdiversus.example.com/careers',
    status: JobStatus.Open,
  },
  {
    slug: 'peer-support-facilitator',
    companySlug: 'ilga-portugal',
    posterSlug: 'ana-rocha',
    title: 'Peer Support Facilitator',
    category: 'Community & Advocacy',
    commitment: 'Part-time',
    seniority: 'Entry',
    format: JobFormat.InPerson,
    location: 'Lisbon, Portugal',
    city: 'Lisbon',
    timezone: 'Europe/Lisbon',
    salary: '€12 / hour',
    rateMin: 12,
    rateMax: 12,
    currency: 'EUR',
    ratePer: 'hour',
    hidePay: false,
    barter: false,
    deadline: null,
    startDate: null,
    desc: 'Facilitate confidential peer-support sessions for queer people navigating identity, family, and transition.',
    tags: ['Peer support', 'Mental health', 'Facilitation'],
    queerRun: false,
    qrLabel: null,
    detail: {
      about: [
        'ILGA Portugal runs a free, confidential peer support line and in-person sessions for LGBTI+ people and their families.',
      ],
      dayToDay: [
        'Facilitate weekly peer-support sessions',
        'Hold space without judgment, following our peer-support training',
        'Escalate to clinical staff when a caller needs more than peer support',
      ],
      lookingFor: [
        'Lived experience navigating queer identity, family, or transition',
        'Comfort holding confidential, emotionally weighty conversations',
      ],
      offer: ['Full training before your first session', 'Ongoing supervision'],
      reviewerNote:
        'Lived experience matters more here than formal credentials.',
    },
    benefits: ['Training provided', 'Supervision included'],
    inclusivity: [
      'Confidentiality is enforced at every level',
      'No judgment, ever',
    ],
    screening: ['Informal chat', 'Reference check'],
    contacts: ['Ana Rocha, Volunteer Coordinator'],
    email: 'jobs@ilga-portugal.example.com',
    link: null,
    status: JobStatus.Open,
  },
  {
    slug: 'bookseller',
    companySlug: 'livraria-devagar',
    posterSlug: 'noa-silva',
    title: 'Bookseller',
    category: 'Retail',
    commitment: 'Part-time',
    seniority: 'Entry',
    format: JobFormat.InPerson,
    location: 'Braga, Portugal',
    city: 'Braga',
    timezone: 'Europe/Lisbon',
    salary: '€800 / month (part-time)',
    rateMin: null,
    rateMax: null,
    currency: null,
    ratePer: null,
    hidePay: false,
    barter: true,
    deadline: null,
    startDate: '2026-09-15',
    desc: 'Help run the shop floor, curate staff picks, and host our monthly queer book club.',
    tags: ['Retail', 'Books', 'Events'],
    queerRun: true,
    qrLabel: 'Queer-run bookshop',
    detail: {
      about: [
        'Livraria Devagar is a small independent bookshop specializing in queer literature, zines, and community events — readings, book clubs, and swap shelves.',
      ],
      dayToDay: [
        'Run the shop floor and till during your shifts',
        'Curate and refresh the staff-picks shelf',
        'Host our monthly queer book club discussion',
      ],
      lookingFor: [
        'A love of queer literature (retail experience is a bonus, not a requirement)',
        'Comfort hosting a small group discussion once a month',
      ],
      offer: ['Staff discount on all stock', 'A say in what the shop stocks'],
      reviewerNote: null,
    },
    benefits: ['Staff discount', 'Free books from the swap shelf'],
    inclusivity: [
      'Shop is fully accessible',
      'Flexible scheduling around care work',
    ],
    screening: ['In-shop trial shift'],
    contacts: ['Noa Silva, Owner'],
    email: null,
    link: null,
    status: JobStatus.Open,
  },
];

interface JobApplicationSeedDefinition {
  jobSlug: string;
  applicantSlug: string;
  answers: JobApplicationAnswer[];
  coverNote: string | null;
  status: JobApplicationStatus;
}

const JOB_APPLICATIONS: JobApplicationSeedDefinition[] = [
  {
    jobSlug: 'backend-engineer',
    applicantSlug: 'tomas-mendes',
    answers: [
      {
        question: 'Why do you want to build QueerPulse?',
        answer:
          'I want the platform I already love using to be sustainable long-term.',
      },
    ],
    coverNote:
      "I've been vouching for people here since week one — would love to help build it.",
    status: JobApplicationStatus.Submitted,
  },
  {
    jobSlug: 'junior-graphic-designer',
    applicantSlug: 'ana-rocha',
    answers: [
      {
        question: 'What print work have you shipped?',
        answer:
          "I've printed a few zine covers for local collectives and would love to do more.",
      },
    ],
    coverNote:
      'I already collaborate with Atelier Pulso informally — this would make it official.',
    status: JobApplicationStatus.Reviewing,
  },
];

/**
 * Idempotently seeds jobs (each FK'd to one of the seeded companies, posted
 * by that company's owner) and a couple of job applications against them.
 * `memberIdBySlug` maps a member's profile slug to their userId — mirrors
 * `seedCommunities`/`seedCompanies`'s identical precedent.
 */
async function seedJobs(
  manager: EntityManager,
  memberIdBySlug: Map<string, string>,
): Promise<void> {
  const jobs = manager.getRepository(Job);
  const companies = manager.getRepository(Company);
  const applications = manager.getRepository(JobApplication);

  const userId = (slug: string): string => {
    const id = memberIdBySlug.get(slug);
    if (!id) {
      throw new Error(`Cannot seed jobs: no seeded member with slug "${slug}"`);
    }
    return id;
  };

  const companyIdBySlug = new Map<string, string>();
  const jobIdBySlug = new Map<string, string>();

  for (const j of JOBS) {
    const existing = await jobs.findOne({ where: { slug: j.slug } });
    if (existing) {
      jobIdBySlug.set(j.slug, existing.id);
      continue;
    }

    let companyId = companyIdBySlug.get(j.companySlug);
    if (!companyId) {
      const company = await companies.findOne({
        where: { slug: j.companySlug },
      });
      if (!company) {
        throw new Error(
          `Cannot seed jobs: no seeded company with slug "${j.companySlug}"`,
        );
      }
      companyId = company.id;
      companyIdBySlug.set(j.companySlug, companyId);
    }

    const job = await jobs.save(
      jobs.create({
        slug: j.slug,
        companyId,
        title: j.title,
        category: j.category,
        commitment: j.commitment,
        seniority: j.seniority,
        format: j.format,
        location: j.location,
        city: j.city,
        timezone: j.timezone,
        salary: j.salary,
        rateMin: j.rateMin,
        rateMax: j.rateMax,
        currency: j.currency,
        ratePer: j.ratePer,
        hidePay: j.hidePay,
        barter: j.barter,
        deadline: j.deadline,
        startDate: j.startDate,
        desc: j.desc,
        tags: j.tags,
        queerRun: j.queerRun,
        qrLabel: j.qrLabel,
        detail: j.detail,
        benefits: j.benefits,
        inclusivity: j.inclusivity,
        screening: j.screening,
        contacts: j.contacts,
        email: j.email,
        link: j.link,
        posterId: userId(j.posterSlug),
        status: j.status,
      }),
    );
    jobIdBySlug.set(j.slug, job.id);

    console.log(`Seeded job ${j.slug}`);
  }

  for (const a of JOB_APPLICATIONS) {
    const jobId = jobIdBySlug.get(a.jobSlug);
    if (!jobId) {
      throw new Error(
        `Cannot seed job applications: no seeded job with slug "${a.jobSlug}"`,
      );
    }
    const applicantId = userId(a.applicantSlug);

    const existing = await applications.findOne({
      where: { jobId, applicantId },
    });
    if (existing) {
      continue;
    }

    await applications.save(
      applications.create({
        jobId,
        applicantId,
        answers: a.answers,
        coverNote: a.coverNote,
        status: a.status,
      }),
    );
    console.log(`Seeded job application: ${a.applicantSlug} -> ${a.jobSlug}`);
  }
}

// Representative volunteer opportunities for local frontend integration,
// spanning every `cause` and both `commit` levels, posted by the seeded
// active members above. Partner links stay null in Phase C (there's no
// `partners` table yet — see `VolunteerOpportunity.partnerId` and
// `.superpowers/sdd/spec-phaseC-volunteering.md`); Phase D back-fills them.
// Poster/team/signup slugs are resolved to userIds at seed time — see
// seedVolunteering().
interface VolunteerSignupSeedDefinition {
  memberSlug: string;
  note: string | null;
}

interface VolunteerOpportunitySeedDefinition {
  slug: string;
  org: string;
  role: string;
  cause: OpportunityCause;
  commit: OpportunityCommitLevel;
  time: string;
  location: string;
  skills: string[];
  desc: string;
  detail: OpportunityDetailBody;
  spotsTotal: number;
  applyRole: string;
  posterSlug: string;
  team: string[]; // member slugs, besides the poster
  signups: VolunteerSignupSeedDefinition[];
}

const VOLUNTEER_OPPORTUNITIES: VolunteerOpportunitySeedDefinition[] = [
  {
    slug: 'mentor-queer-youth',
    org: 'Queer Youth Collective',
    role: 'Mentor',
    cause: OpportunityCause.Youth,
    commit: OpportunityCommitLevel.Low,
    time: '2 hrs / week',
    location: 'Lisbon',
    skills: ['Mentoring', 'Active listening'],
    desc: 'Be a steady, judgment-free presence for a queer teen finding their footing.',
    detail: {
      why: [
        'Many queer youth in our network have no out adult in their life to talk to.',
        'A regular, low-pressure mentor relationship makes a measurable difference.',
      ],
      tasks: [
        {
          title: 'Weekly check-in',
          desc: 'A 1:1 chat, in person or video call, on whatever the mentee wants to talk about.',
        },
        {
          title: 'Occasional outings',
          desc: 'Join a low-key group hangout once a month or so.',
        },
      ],
      commitments: [
        { label: 'Time', detail: '2 hours a week for at least 3 months' },
        { label: 'Training', detail: 'One 90-minute onboarding session' },
      ],
      goodFor: [
        'People who like consistent, ongoing commitments',
        'Good listeners',
      ],
      teamIntro:
        'You will be paired 1:1 and checked in on by our small coordinating team.',
    },
    spotsTotal: 4,
    applyRole: 'Volunteer Coordinator',
    posterSlug: 'ana-rocha',
    team: ['noa-silva'],
    signups: [
      {
        memberSlug: 'tomas-mendes',
        note: 'I mentored at a similar org back in Porto — happy to bring that experience here.',
      },
      { memberSlug: 'noa-silva', note: null },
    ],
  },
  {
    slug: 'lgbti-rights-helpline',
    org: 'ILGA Portugal',
    role: 'Helpline Volunteer',
    cause: OpportunityCause.Rights,
    commit: OpportunityCommitLevel.Medium,
    time: '4 hrs / week',
    location: 'Lisbon',
    skills: ['Phone support', 'Confidentiality'],
    desc: 'Answer calls from LGBTI+ people navigating discrimination, family conflict, and legal questions.',
    detail: {
      why: [
        'Our helpline is often the first place someone reaches out after facing discrimination.',
        'Trained volunteers keep the line staffed for more hours each week.',
      ],
      tasks: [
        {
          title: 'Staff a weekly shift',
          desc: 'Answer incoming calls and triage to legal or peer-support staff as needed.',
        },
        {
          title: 'Log calls',
          desc: 'Keep confidential, anonymized notes for our quarterly impact report.',
        },
      ],
      commitments: [
        { label: 'Time', detail: '4 hours a week, one fixed shift' },
        {
          label: 'Training',
          detail: 'Two-day helpline training before your first shift',
        },
      ],
      goodFor: [
        'Calm under pressure',
        'Comfortable holding confidential conversations',
      ],
      teamIntro: 'Every shift is paired with a senior volunteer for backup.',
    },
    spotsTotal: 3,
    applyRole: 'Volunteer Coordinator',
    posterSlug: 'ana-rocha',
    team: [],
    signups: [
      {
        memberSlug: 'noa-silva',
        note: "I've done crisis-line work before and want to bring that here.",
      },
    ],
  },
  {
    slug: 'peer-support-facilitator-training',
    org: 'ILGA Portugal',
    role: 'Peer Support Trainee',
    cause: OpportunityCause.Health,
    commit: OpportunityCommitLevel.Medium,
    time: '3 hrs / week',
    location: 'Lisbon',
    skills: ['Peer support', 'Facilitation'],
    desc: 'Train to co-facilitate confidential peer-support sessions for queer people navigating identity and family.',
    detail: {
      why: [
        'Lived experience matters more here than formal credentials.',
        'Trainees shadow sessions before facilitating solo, so the bar to start is low.',
      ],
      tasks: [
        {
          title: 'Attend training sessions',
          desc: 'Weekly training over 6 weeks.',
        },
        {
          title: 'Shadow a session',
          desc: 'Sit in on live peer-support sessions with a senior facilitator.',
        },
      ],
      commitments: [
        {
          label: 'Time',
          detail: '3 hours a week during the 6-week training period',
        },
        { label: 'Ongoing', detail: 'One session a week once qualified' },
      ],
      goodFor: [
        'Lived experience of queer identity, family, or transition',
        'Warm, patient listeners',
      ],
      teamIntro: 'Full supervision throughout training and beyond.',
    },
    spotsTotal: 2,
    applyRole: 'Volunteer Coordinator',
    posterSlug: 'ana-rocha',
    team: [],
    signups: [{ memberSlug: 'tomas-mendes', note: null }],
  },
  {
    slug: 'queer-shelter-weekend-support',
    org: 'Casa Arco-Íris',
    role: 'Weekend Support Volunteer',
    cause: OpportunityCause.Housing,
    commit: OpportunityCommitLevel.Low,
    time: '3 hrs / weekend',
    location: 'Porto',
    skills: ['Hospitality', 'Cooking'],
    desc: 'Help run weekend meals and light upkeep at a shelter for queer youth experiencing housing instability.',
    detail: {
      why: [
        'Weekend staffing is thin, and residents notice when volunteers show up consistently.',
      ],
      tasks: [
        {
          title: 'Cook or help serve a weekend meal',
          desc: 'Saturday or Sunday, your pick.',
        },
        {
          title: 'Light upkeep',
          desc: 'Tidy common spaces alongside residents.',
        },
      ],
      commitments: [
        { label: 'Time', detail: '3 hours, one weekend day a month' },
      ],
      goodFor: [
        'People who enjoy hands-on, practical help',
        'Reliable, low-drama presences',
      ],
      teamIntro: null,
    },
    spotsTotal: 5,
    applyRole: 'Shelter Coordinator',
    posterSlug: 'noa-silva',
    team: ['tomas-mendes'],
    signups: [],
  },
  {
    slug: 'zine-workshop-facilitator',
    org: 'Livraria Devagar',
    role: 'Workshop Facilitator',
    cause: OpportunityCause.Arts,
    commit: OpportunityCommitLevel.Low,
    time: '2 hrs / month',
    location: 'Braga',
    skills: ['Facilitation', 'Zine-making'],
    desc: 'Run a monthly drop-in zine-making workshop for queer teens and young adults at the shop.',
    detail: {
      why: [
        'Making something with your hands, together, is its own kind of community-building.',
      ],
      tasks: [
        {
          title: 'Plan a monthly prompt',
          desc: "Pick a loose theme so people aren't staring at a blank page.",
        },
        {
          title: 'Facilitate the session',
          desc: 'Two hours, materials provided by the shop.',
        },
      ],
      commitments: [{ label: 'Time', detail: '2 hours once a month' }],
      goodFor: ['Comfortable running a room', 'Zine-makers and illustrators'],
      teamIntro:
        'You will co-run it alongside shop staff the first couple of times.',
    },
    spotsTotal: 3,
    applyRole: 'Owner',
    posterSlug: 'noa-silva',
    team: [],
    signups: [
      {
        memberSlug: 'ana-rocha',
        note: 'I run a similar workshop informally already — would love to make it official.',
      },
      { memberSlug: 'tomas-mendes', note: null },
    ],
  },
];

/**
 * Idempotently seeds volunteer opportunities (each posted by one of the
 * seeded active members, some with a co-listed team and a few signups).
 * `memberIdBySlug` maps a member's profile slug to their userId — mirrors
 * `seedCommunities`/`seedCompanies`/`seedJobs`'s identical precedent.
 */
async function seedVolunteering(
  manager: EntityManager,
  memberIdBySlug: Map<string, string>,
): Promise<void> {
  const opportunities = manager.getRepository(VolunteerOpportunity);
  const team = manager.getRepository(VolunteerOpportunityTeam);
  const signups = manager.getRepository(VolunteerSignup);

  const userId = (slug: string): string => {
    const id = memberIdBySlug.get(slug);
    if (!id) {
      throw new Error(
        `Cannot seed volunteering: no seeded member with slug "${slug}"`,
      );
    }
    return id;
  };

  for (const o of VOLUNTEER_OPPORTUNITIES) {
    const existing = await opportunities.findOne({ where: { slug: o.slug } });
    if (existing) {
      continue;
    }

    const opportunity = await opportunities.save(
      opportunities.create({
        slug: o.slug,
        org: o.org,
        // Partner links stay null in Phase C — see the comment above
        // `VOLUNTEER_OPPORTUNITIES`.
        partnerId: null,
        role: o.role,
        cause: o.cause,
        commit: o.commit,
        time: o.time,
        location: o.location,
        skills: o.skills,
        desc: o.desc,
        detail: o.detail,
        spotsTotal: o.spotsTotal,
        applyRole: o.applyRole,
        posterId: userId(o.posterSlug),
        status: OpportunityStatus.Open,
      }),
    );

    for (const memberSlug of o.team) {
      await team.save(
        team.create({
          opportunityId: opportunity.id,
          userId: userId(memberSlug),
        }),
      );
    }

    for (const s of o.signups) {
      await signups.save(
        signups.create({
          opportunityId: opportunity.id,
          userId: userId(s.memberSlug),
          note: s.note,
        }),
      );
    }

    console.log(`Seeded volunteer opportunity ${o.slug}`);
  }
}

// Representative partners for local frontend integration: three `approved`
// (so the public `/partners` directory renders) and one `pending`
// application (so the admin review path has content). Each is "submitted
// by" one of the seeded active members — resolved to a userId at seed time,
// mirroring every other `seed*` function's `memberIdBySlug` precedent.
interface PartnerSeedDefinition {
  slug: string;
  name: string;
  logo: string;
  region: PartnerRegion;
  regionLabel: string;
  city: string;
  desc: string;
  tags: string[];
  tier: string;
  since: string;
  eyebrow: string;
  tagline: string;
  about: string[];
  stats: PartnerStat[];
  aboutMore: PartnerSection[];
  jointWork: PartnerJointWork[];
  timeline: PartnerTimelineItem[];
  how: PartnerSection[];
  funding: string;
  atGlance: PartnerAtGlance[];
  contact: PartnerContact;
  status: PartnerStatus;
  submittedBySlug: string;
  reviewNote: string | null;
}

const PARTNERS: PartnerSeedDefinition[] = [
  {
    slug: 'ilga-portugal-partner',
    name: 'ILGA Portugal',
    logo: 'IP',
    region: PartnerRegion.Pt,
    regionLabel: 'Portugal',
    city: 'Lisbon',
    desc: 'Advocacy and support for LGBTI+ rights across Portugal.',
    tags: ['Advocacy', 'Support'],
    tier: 'Founding partner',
    since: '2019',
    eyebrow: 'Rights & advocacy',
    tagline: 'Rights, not favors.',
    about: [
      'ILGA Portugal has run legal advocacy and peer-support services since 1995.',
      'QueerPulse members volunteer on their helpline and co-host events with them.',
    ],
    stats: [
      { value: '30+', label: 'Years of advocacy' },
      { value: '1.2k', label: 'People supported / year' },
    ],
    aboutMore: [
      {
        heading: 'Why we partner',
        body: 'Their legal advocacy work backs several of the protections our members rely on.',
      },
    ],
    jointWork: [
      {
        kicker: 'Helpline',
        title: 'Staffing the LGBTI+ helpline together',
        dek: 'QueerPulse volunteers rotate shifts alongside ILGA staff.',
        footLeft: 'Since 2023',
        footRight: '4 volunteers/month',
      },
    ],
    timeline: [
      {
        date: '2023',
        title: 'Helpline partnership begins',
        body: 'First QueerPulse volunteers join the rotation.',
      },
    ],
    how: [
      {
        heading: 'Volunteer',
        body: 'Sign up for a helpline shift or a peer-support training cohort.',
      },
    ],
    funding: 'Grants, membership dues, and community fundraising.',
    atGlance: [
      { label: 'Founded', value: '1995' },
      { label: 'Focus', value: 'Legal advocacy, peer support' },
    ],
    contact: {
      phone: null,
      phoneNote: null,
      email: 'geral@ilga-portugal.pt',
      website: 'https://ilga-portugal.pt',
      address: 'Lisbon, Portugal',
    },
    status: PartnerStatus.Approved,
    submittedBySlug: 'ana-rocha',
    reviewNote: null,
  },
  {
    slug: 'casa-arco-iris-partner',
    name: 'Casa Arco-Íris',
    logo: 'CA',
    region: PartnerRegion.Pt,
    regionLabel: 'Portugal',
    city: 'Porto',
    desc: 'A shelter for queer youth experiencing housing instability.',
    tags: ['Housing', 'Youth'],
    tier: 'Community partner',
    since: '2021',
    eyebrow: 'Housing & shelter',
    tagline: 'A safe place to land.',
    about: [
      'Casa Arco-Íris runs a small shelter for queer youth in Porto, with weekend meal and upkeep support run largely by volunteers.',
    ],
    stats: [{ value: '18', label: 'Residents housed / year' }],
    aboutMore: [
      {
        heading: 'Why we partner',
        body: 'Weekend staffing is thin, and consistent volunteers make a visible difference for residents.',
      },
    ],
    jointWork: [
      {
        kicker: 'Weekend support',
        title: 'Weekend meals and light upkeep',
        dek: 'QueerPulse volunteers cover Saturday or Sunday shifts.',
        footLeft: 'Since 2024',
        footRight: '5 volunteers/month',
      },
    ],
    timeline: [
      {
        date: '2024',
        title: 'Weekend volunteer rotation begins',
        body: 'First QueerPulse volunteers sign up for weekend shifts.',
      },
    ],
    how: [
      {
        heading: 'Volunteer',
        body: 'Sign up for a weekend meal or upkeep shift.',
      },
    ],
    funding: 'Municipal grants and individual donations.',
    atGlance: [
      { label: 'Founded', value: '2021' },
      { label: 'Focus', value: 'Youth housing' },
    ],
    contact: {
      phone: null,
      phoneNote: null,
      email: 'contacto@casaarcoiris.example.com',
      website: null,
      address: 'Porto, Portugal',
    },
    status: PartnerStatus.Approved,
    submittedBySlug: 'noa-silva',
    reviewNote: null,
  },
  {
    slug: 'livraria-devagar-partner',
    name: 'Livraria Devagar',
    logo: 'LD',
    region: PartnerRegion.Pt,
    regionLabel: 'Portugal',
    city: 'Braga',
    desc: 'A queer-run independent bookshop hosting a monthly zine workshop.',
    tags: ['Arts', 'Community'],
    tier: 'Community partner',
    since: '2022',
    eyebrow: 'Arts & community',
    tagline: 'Slow reading, together.',
    about: [
      'Livraria Devagar is a small independent bookshop specializing in queer literature, zines, and community events.',
    ],
    stats: [{ value: '12', label: 'Workshops hosted' }],
    aboutMore: [
      {
        heading: 'Why we partner',
        body: 'Their monthly zine workshop is one of the few hands-on, low-pressure gathering spaces we co-host.',
      },
    ],
    jointWork: [
      {
        kicker: 'Workshop',
        title: 'Monthly drop-in zine-making workshop',
        dek: 'QueerPulse members co-facilitate alongside shop staff.',
        footLeft: 'Since 2024',
        footRight: 'Monthly',
      },
    ],
    timeline: [
      {
        date: '2024',
        title: 'Zine workshop partnership begins',
        body: 'First QueerPulse-facilitated session runs at the shop.',
      },
    ],
    how: [
      {
        heading: 'Volunteer',
        body: 'Co-facilitate a monthly workshop session.',
      },
    ],
    funding: 'Retail sales and event ticket revenue.',
    atGlance: [
      { label: 'Founded', value: '2019' },
      { label: 'Focus', value: 'Arts & literature' },
    ],
    contact: {
      phone: null,
      phoneNote: null,
      email: null,
      website: null,
      address: 'Braga, Portugal',
    },
    status: PartnerStatus.Approved,
    submittedBySlug: 'noa-silva',
    reviewNote: null,
  },
  {
    slug: 'queer-youth-collective-application',
    name: 'Queer Youth Collective',
    logo: 'QY',
    region: PartnerRegion.Pt,
    regionLabel: 'Portugal',
    city: 'Lisbon',
    desc: 'A peer-mentoring collective pairing queer youth with adult mentors.',
    tags: ['Youth', 'Mentoring'],
    tier: 'Applicant',
    since: '2025',
    eyebrow: 'Youth & mentoring',
    tagline: 'A steady, judgment-free presence.',
    about: [
      'Queer Youth Collective pairs queer teens with vetted adult mentors for low-pressure, ongoing 1:1 relationships.',
    ],
    stats: [],
    aboutMore: [],
    jointWork: [],
    timeline: [],
    how: [],
    funding: '',
    atGlance: [],
    contact: {
      phone: null,
      phoneNote: null,
      email: 'hello@queeryouthcollective.example.com',
      website: null,
      address: null,
    },
    // Deliberately left pending — this is the seed's "admin review queue has
    // content" fixture (see the spec's Seed section).
    status: PartnerStatus.Pending,
    submittedBySlug: 'ana-rocha',
    reviewNote: null,
  },
];

/**
 * Idempotently seeds partners (three `approved`, one `pending`), each
 * "submitted by" one of the seeded active members. Returns a slug->id map so
 * `backfillVolunteeringPartnerLinks` can link seeded volunteer opportunities
 * to them without a second slug lookup.
 */
async function seedPartners(
  manager: EntityManager,
  memberIdBySlug: Map<string, string>,
): Promise<Map<string, string>> {
  const partners = manager.getRepository(Partner);
  const partnerIdBySlug = new Map<string, string>();

  const userId = (slug: string): string => {
    const id = memberIdBySlug.get(slug);
    if (!id) {
      throw new Error(
        `Cannot seed partners: no seeded member with slug "${slug}"`,
      );
    }
    return id;
  };

  for (const p of PARTNERS) {
    const existing = await partners.findOne({ where: { slug: p.slug } });
    if (existing) {
      partnerIdBySlug.set(p.slug, existing.id);
      continue;
    }

    const partner = await partners.save(
      partners.create({
        slug: p.slug,
        name: p.name,
        logo: p.logo,
        region: p.region,
        regionLabel: p.regionLabel,
        city: p.city,
        desc: p.desc,
        tags: p.tags,
        tier: p.tier,
        since: p.since,
        eyebrow: p.eyebrow,
        tagline: p.tagline,
        about: p.about,
        stats: p.stats,
        aboutMore: p.aboutMore,
        jointWork: p.jointWork,
        timeline: p.timeline,
        how: p.how,
        funding: p.funding,
        atGlance: p.atGlance,
        contact: p.contact,
        status: p.status,
        submittedById: userId(p.submittedBySlug),
        reviewNote: p.reviewNote,
      }),
    );
    partnerIdBySlug.set(p.slug, partner.id);

    console.log(`Seeded partner ${p.slug} (${p.status})`);
  }

  return partnerIdBySlug;
}

/**
 * Back-fills `partner_id` on a couple of the volunteer opportunities seeded
 * by `seedVolunteering` (which always left it `null` — the `partners` table
 * didn't exist yet when that ran; see the comment above
 * `VOLUNTEER_OPPORTUNITIES`), now that `seedPartners` has produced real
 * partner rows to link to. Idempotent: re-running just re-sets the same ids.
 */
async function backfillVolunteeringPartnerLinks(
  manager: EntityManager,
  partnerIdBySlug: Map<string, string>,
): Promise<void> {
  const opportunities = manager.getRepository(VolunteerOpportunity);
  const links: Array<{ opportunitySlug: string; partnerSlug: string }> = [
    {
      opportunitySlug: 'lgbti-rights-helpline',
      partnerSlug: 'ilga-portugal-partner',
    },
    {
      opportunitySlug: 'queer-shelter-weekend-support',
      partnerSlug: 'casa-arco-iris-partner',
    },
  ];

  for (const { opportunitySlug, partnerSlug } of links) {
    const partnerId = partnerIdBySlug.get(partnerSlug);
    if (!partnerId) {
      throw new Error(
        `Cannot back-fill volunteering partner link: no seeded partner with slug "${partnerSlug}"`,
      );
    }
    await opportunities.update({ slug: opportunitySlug }, { partnerId });
  }
  console.log('Back-filled partner_id on seeded volunteer opportunities');
}

// Representative businesses for the public directory (`/local/directory`) and
// the host page's "Partner spaces" card. Mirrors real entries from the
// frontend fixture `queerpulse/src/features/marketing/directoryPlaces.ts` so
// the live directory reads recognisably. All are `live` (publicly visible);
// three are flagged `isPartneredWithQueerpulse` with venue capacity so the
// host page renders real partner venues instead of the old fabricated card.
interface ListingSeedDefinition {
  ref: string;
  slug: string;
  ownerSlug: string;
  name: string;
  cats: string[];
  hood: string;
  price: string;
  blurb: string;
  tagline: string;
  ownerName: string;
  ownerRole: string;
  ownerBio: string;
  address: string;
  hoursNote: string;
  tags: string[];
  whatItIs: string[];
  goodFor: string[];
  /** Gallery caption cells (the prototype renders captions, not images). */
  gallery: string[];
  social: {
    instagram?: string;
    website?: string;
    email?: string;
    phone?: string;
  };
  // Partner-space fields — set only on the venues that host gatherings.
  isPartneredWithQueerpulse?: boolean;
  spaceType?: string;
  capacity?: number;
  hostNote?: string;
}

const LISTINGS: ListingSeedDefinition[] = [
  {
    ref: 'QPL-2026-1001',
    slug: 'atelier-pulso',
    ownerSlug: 'tomas-mendes',
    name: 'Atelier Pulso',
    cats: ['design'],
    hood: 'Príncipe Real',
    price: '€€',
    blurb:
      'Graphic design studio for cultural institutions and small presses. Open by appointment.',
    tagline: 'A queer design studio for the people making culture in this city.',
    ownerName: 'Inês Faro',
    ownerRole: 'Founder · designer',
    ownerBio:
      'Designer for cultural institutions and small presses. Believes good design is a form of care.',
    address: 'R. da Escola Politécnica 84 · Príncipe Real',
    hoursNote: 'Open by appointment — message to arrange a time.',
    tags: ['Design studio', 'By appointment', 'Step-free entrance'],
    whatItIs: [
      'Inês runs Atelier Pulso as a small studio doing brand identity and editorial design — mostly for cultural institutions, small presses, and queer projects.',
      'It is genuinely open by appointment: message ahead to see the print archive or talk about a project. Riso and letterpress on site.',
    ],
    goodFor: [
      'Brand identity for a queer project',
      'Editorial & book design',
      'Seeing a working print archive',
    ],
    gallery: ['Studio · main desk', 'Print archive', 'Type wall', 'Window onto Príncipe Real'],
    social: {
      instagram: '@atelierpulso',
      website: 'atelierpulso.pt',
      email: 'ola@atelierpulso.pt',
    },
    isPartneredWithQueerpulse: true,
    spaceType: 'Studio',
    capacity: 15,
    hostNote: 'member-run',
  },
  {
    ref: 'QPL-2026-1002',
    slug: 'queer-supper-club',
    ownerSlug: 'tomas-mendes',
    name: 'Queer Supper Club',
    cats: ['food'],
    hood: 'Mouraria',
    price: '€€€',
    blurb:
      'Monthly intimate dinners — twelve seats, seasonal menu, honest cooking. The most important table in Mouraria.',
    tagline: 'Twelve seats, one long table, the best night out sitting down.',
    ownerName: 'Tomás Beto',
    ownerRole: 'Chef · host',
    ownerBio:
      'Chef and supper-club host. Cooks the way his avó did, for people who need a table.',
    address: 'Address shared with ticket · Mouraria',
    hoursNote: 'Monthly seatings — book a seat for the next dinner.',
    tags: ['Supper club', 'Monthly · ticketed', 'Dietary-friendly'],
    whatItIs: [
      'Once a month Tomás opens his Mouraria home and cooks a seasonal menu for twelve strangers who leave as something closer to friends.',
      'Tickets go fast and the list is half community, half newcomers placed deliberately next to people they should meet.',
    ],
    goodFor: [
      'Meeting people without the bar',
      'A special-occasion dinner',
      'Solo diners (you’ll be seated well)',
    ],
    gallery: ['The long table', 'Open kitchen', 'Mouraria courtyard', 'Dessert course'],
    social: { instagram: '@queersupperclub', email: 'table@queersupper.pt' },
    isPartneredWithQueerpulse: true,
    spaceType: 'Kitchen + dining room',
    capacity: 20,
    hostNote: 'ticketed',
  },
  {
    ref: 'QPL-2026-1003',
    slug: 'galeria-lume',
    ownerSlug: 'ana-rocha',
    name: 'Galeria Lume',
    cats: ['culture'],
    hood: 'Marvila',
    price: '€',
    blurb:
      'Artist-run gallery in a Marvila warehouse. Programming focuses on emerging queer and feminist artists.',
    tagline: 'A warehouse gallery that bets on queer artists before the market does.',
    ownerName: 'Lume collective',
    ownerRole: 'Artist-run',
    ownerBio:
      'Run by an artist collective; several members are on QueerPulse and overlap with Rainbow Arts.',
    address: 'R. do Açúcar 76 · Marvila',
    hoursNote: 'Open Wed–Sun afternoons. Openings run late.',
    tags: ['Gallery', 'Free entry', 'Step-free · large'],
    whatItIs: [
      'Lume is an artist-run gallery in a Marvila warehouse, programming queer and feminist work with a bias toward emerging artists.',
      'Entry is free, the openings are generous, and the project room is often someone’s first-ever solo show.',
    ],
    goodFor: [
      'Seeing emerging queer art',
      'Generous, social openings',
      'A first solo show as an artist',
    ],
    gallery: ['Main hall', 'Current show', 'Project room', 'Marvila exterior'],
    social: {
      instagram: '@galerialume',
      website: 'galerialume.pt',
      email: 'ola@galerialume.pt',
    },
    isPartneredWithQueerpulse: true,
    spaceType: 'Warehouse',
    capacity: 50,
    hostNote: 'events only',
  },
  {
    ref: 'QPL-2026-1004',
    slug: 'livraria-bertha',
    ownerSlug: 'noa-silva',
    name: 'Livraria Bertha',
    cats: ['culture'],
    hood: 'Príncipe Real',
    price: '€€',
    blurb:
      'Queer-run independent bookshop with a strong feminist and LGBTQ+ section. Regular readings and launches.',
    tagline: 'The bookshop that keeps the section you came for at the front.',
    ownerName: 'Bertha collective',
    ownerRole: 'Worker co-op',
    ownerBio:
      'Run as a small worker co-operative. Several of the booksellers are QueerPulse members.',
    address: 'R. da Imprensa Nacional 48 · Príncipe Real',
    hoursNote: 'Open Tue–Sun. Event nights run later.',
    tags: ['Bookshop', 'Events space', 'Step-free'],
    whatItIs: [
      'Bertha is a small queer-run independent bookshop where the feminist and LGBTQ+ titles are the front table, curated by people who’ve read them.',
      'Most weeks there’s a reading, a launch, or a book club squeezed between the stacks.',
    ],
    goodFor: [
      'Finding queer & feminist titles',
      'Readings and launches',
      'A staff recommendation',
    ],
    gallery: ['Front table', 'Queer & feminist wall', 'Reading corner', 'Event night'],
    social: {
      instagram: '@livrariabertha',
      website: 'livrariabertha.pt',
      email: 'ola@livrariabertha.pt',
    },
  },
  {
    ref: 'QPL-2026-1005',
    slug: 'a-farinha',
    ownerSlug: 'ana-rocha',
    name: 'A Farinha',
    cats: ['food'],
    hood: 'Arroios',
    price: '€€€',
    blurb:
      'Queer-owned natural wine bar and small-plates kitchen. Seasonal menu, opinionated wine list.',
    tagline: 'Natural wine, small plates, and a room that wants you to stay.',
    ownerName: 'Marco & Renato',
    ownerRole: 'Owners',
    ownerBio:
      'A couple who left restaurant kitchens to open the room they wanted to drink in. One is a QueerPulse member.',
    address: 'R. de Arroios 142 · Arroios',
    hoursNote: 'Evenings, Tue–Sun. Closed Mondays.',
    tags: ['Wine bar · small plates', 'Evenings', 'Ground floor'],
    whatItIs: [
      'A Farinha is a queer-owned natural wine bar and small-plates kitchen in Arroios — a short seasonal menu and a long, opinionated wine list.',
      'It’s the place for a second date, a celebration, or a slow Tuesday that turns into something.',
    ],
    goodFor: [
      'A great second date',
      'Natural wine guidance',
      'Celebrating something',
    ],
    gallery: ['The bar', 'Small plates', 'Wine wall', 'Arroios corner'],
    social: {
      instagram: '@afarinha.lisboa',
      website: 'afarinha.pt',
      email: 'reservas@afarinha.pt',
      phone: '+351 21 099 8877',
    },
  },
  {
    ref: 'QPL-2026-1006',
    slug: 'bairro-alto-studio',
    ownerSlug: 'noa-silva',
    name: 'Bairro Alto Studio',
    cats: ['tech'],
    hood: 'Bairro Alto',
    price: '€€',
    blurb:
      'Music production studio available for session hire, specialising in electronic and experimental work.',
    tagline: 'A queer-run music studio where experimental isn’t a dirty word.',
    ownerName: 'Diogo Reis',
    ownerRole: 'Producer · engineer',
    ownerBio:
      'Music producer and Queer Runners regular. Specialises in electronic and experimental work.',
    address: 'R. da Atalaia 90 · Bairro Alto',
    hoursNote: 'Session hire by booking, day and night slots.',
    tags: ['Music studio', 'Session hire', 'Lift access'],
    whatItIs: [
      'Diogo runs a session-hire production studio leaning electronic and experimental, with a serious modular wall and a punchy live room.',
      'Rates are fair, and community members get priority booking and a sliding scale for first records.',
    ],
    goodFor: [
      'Recording an electronic record',
      'Mixing & mastering',
      'First-record sliding scale',
    ],
    gallery: ['The desk', 'Live room', 'Modular wall', 'Bairro Alto rooftop'],
    social: {
      instagram: '@bairroaltostudio',
      website: 'bairroalto.studio',
      email: 'book@bairroalto.studio',
    },
  },
  {
    ref: 'QPL-2026-1007',
    slug: 'navalha',
    ownerSlug: 'tomas-mendes',
    name: 'Navalha',
    cats: ['grooming'],
    hood: 'Príncipe Real',
    price: '€€',
    blurb:
      'Queer-owned barbershop known for trans haircuts done right. No awkward questions, no gendered pricing.',
    tagline: 'The cut you ask for is the cut you get — no negotiation.',
    ownerName: 'Vasco Lima',
    ownerRole: 'Owner · barber',
    ownerBio:
      'Opened Navalha after years of sending friends across town for a safe cut. QueerPulse member from day one.',
    address: 'R. do Século 120 · Príncipe Real',
    hoursNote: 'Tue–Sat, walk-ins welcome, booking advised.',
    tags: ['Barbershop', 'Walk-in & booking', 'Ground floor'],
    whatItIs: [
      'Navalha is a queer-owned barbershop built on giving trans and non-binary clients the haircut they actually asked for, without the interrogation.',
      'Pricing is by service, never by gender or hair length.',
    ],
    goodFor: [
      'Trans & non-binary cuts done right',
      'A first big chop, held gently',
      'Gender-neutral pricing',
    ],
    gallery: ['The chairs', 'Mirror wall', 'Príncipe Real window', 'Product shelf'],
    social: {
      instagram: '@navalha.barbearia',
      email: 'ola@navalha.pt',
      phone: '+351 21 347 2200',
    },
  },
  {
    ref: 'QPL-2026-1008',
    slug: 'movimento',
    ownerSlug: 'ana-rocha',
    name: 'Movimento',
    cats: ['fitness'],
    hood: 'Alfama',
    price: '€',
    blurb:
      'Yoga, capoeira, and weights in a converted Alfama warehouse. Queer-run, sliding-scale memberships.',
    tagline: 'Yoga, capoeira, and iron under one Alfama roof — pay what you can.',
    ownerName: 'Rui & Pedro',
    ownerRole: 'Co-founders',
    ownerBio:
      'Two friends who wanted one room for all the ways they move. Queer-run, sliding-scale on principle.',
    address: 'Beco do Mexias 4 · Alfama',
    hoursNote: 'Class schedule Mon–Sat; weights room open daily.',
    tags: ['Movement studio', 'Sliding scale', 'Ramp access'],
    whatItIs: [
      'Movimento is a queer-run movement space in a converted Alfama warehouse: yoga at dawn, capoeira in the evening, free weights in between.',
      'Memberships are sliding-scale and nobody checks your maths, so the room ends up genuinely mixed.',
    ],
    goodFor: [
      'Mixing yoga, capoeira & weights',
      'Pay-what-you-can access',
      'A genuinely mixed room',
    ],
    gallery: ['Warehouse floor', 'Capoeira roda', 'Weights corner', 'Alfama rooftop'],
    social: {
      instagram: '@movimento.alfama',
      website: 'movimento.pt',
      email: 'ola@movimento.pt',
    },
  },
];

// Two reviews per seeded listing, keyed by slug. Imported/client reviews carry
// no member link (reviewer_id stays null); the aggregate star rating on the
// directory detail page is computed from these.
interface ListingReviewSeed {
  name: string;
  byline: string;
  stars: number;
  text: string;
  helpful: number;
}

const LISTING_REVIEWS: Record<string, ListingReviewSeed[]> = {
  'atelier-pulso': [
    {
      name: 'André Quintela',
      byline: 'he/him · client',
      stars: 5,
      text: 'Inês rebuilt my studio identity and made it feel more like me than my old one did. Patient, fast, honest about what wasn’t working.',
      helpful: 12,
    },
    {
      name: 'Livraria Bertha',
      byline: 'partner',
      stars: 5,
      text: 'Designed our entire signage and event series. Every queer press in Lisbon should be working with her.',
      helpful: 7,
    },
  ],
  'queer-supper-club': [
    {
      name: 'Carla Nunes',
      byline: 'she/her · regular',
      stars: 5,
      text: 'I came alone to my first one terrified and left with three numbers and a full heart. Tomás seats you like he’s thought about it all week.',
      helpful: 28,
    },
    {
      name: 'Kai Oliveira',
      byline: 'they/them · 2 visits',
      stars: 5,
      text: 'The food is genuinely excellent and the room is the point. Best twelve euros-an-hour my social life has ever spent.',
      helpful: 15,
    },
  ],
  'galeria-lume': [
    {
      name: 'Luísa Marques',
      byline: 'she/her · curator',
      stars: 5,
      text: 'Lume shows the work the big institutions will claim to have discovered in five years. Go now and be smug later.',
      helpful: 12,
    },
    {
      name: 'Beatriz Pinto',
      byline: 'she/her · artist',
      stars: 5,
      text: 'They gave me my first solo room and treated it like it mattered. Openings feel like a community, not a market.',
      helpful: 8,
    },
  ],
  'livraria-bertha': [
    {
      name: 'Sofia Castaño',
      byline: 'she/her · regular',
      stars: 5,
      text: 'I have never left empty-handed and never left poorer in spirit. The recommendations card by the till is a hazard.',
      helpful: 17,
    },
    {
      name: 'Nuno Ferreira',
      byline: 'he/him · 4 visits',
      stars: 5,
      text: 'Came for one book, stayed for a launch I didn’t know was happening, met half a reading group. That’s Bertha.',
      helpful: 11,
    },
  ],
  'a-farinha': [
    {
      name: 'Anika Rao',
      byline: 'she/her · regular',
      stars: 5,
      text: 'Told Renato "something orange and a bit weird" and he changed my whole opinion of wine. The plates kept coming and I let them.',
      helpful: 16,
    },
    {
      name: 'Sofia Castaño',
      byline: 'she/her · 3 visits',
      stars: 5,
      text: 'Brought a date, then my friends, then my mother. Passed every test. Hospitality you can feel.',
      helpful: 9,
    },
  ],
  'bairro-alto-studio': [
    {
      name: 'Kai Oliveira',
      byline: 'they/them · artist',
      stars: 5,
      text: 'Diogo got a sound out of my demos I’d been chasing for two years. The modular wall alone is worth the trip.',
      helpful: 10,
    },
    {
      name: 'Rita Sousa',
      byline: 'she/her · client',
      stars: 5,
      text: 'First-record sliding scale meant I could afford to make the thing properly. Patient with a total beginner.',
      helpful: 8,
    },
  ],
  navalha: [
    {
      name: 'Kai Oliveira',
      byline: 'they/them · regular',
      stars: 5,
      text: 'Asked for a cut I’d been too scared to ask for anywhere. Vasco just nodded and did it perfectly. I cried a little in the chair.',
      helpful: 41,
    },
    {
      name: 'Nuno Ferreira',
      byline: 'he/him · monthly',
      stars: 5,
      text: 'Same price as my old place, none of the awkwardness, twice the skill. Never going anywhere else.',
      helpful: 13,
    },
  ],
  movimento: [
    {
      name: 'Kai Oliveira',
      byline: 'they/them · member',
      stars: 5,
      text: 'Where else can you do sun salutations and then deadlift in the same hour for whatever you can pay? Alfama’s best-kept secret.',
      helpful: 15,
    },
    {
      name: 'Tomás Beto',
      byline: 'he/him · capoeira',
      stars: 4,
      text: 'The roda on Sundays is pure joy and properly mixed — ages, bodies, levels. Sliding scale means everyone’s actually there.',
      helpful: 8,
    },
  ],
};

// Upcoming events hosted at a listing's venue, keyed by listing slug. `inDays`
// is relative to seed-run time so seeded events are always in the future (the
// directory detail page only shows upcoming, published events).
interface ListingEventSeed {
  slug: string;
  title: string;
  description: string;
  inDays: number;
  hour: number;
}

const LISTING_EVENTS: Record<string, ListingEventSeed[]> = {
  'galeria-lume': [
    {
      slug: 'lume-group-show-opening',
      title: 'Opening — group show, eight emerging artists',
      description:
        'The summer group show opens with eight emerging queer and feminist artists. Free entry, generous openings.',
      inDays: 12,
      hour: 18,
    },
  ],
  'livraria-bertha': [
    {
      slug: 'bertha-queer-poetry-reading',
      title: 'Reading — new queer poetry in translation',
      description: 'An evening of new queer poetry in translation, read between the stacks.',
      inDays: 5,
      hour: 19,
    },
    {
      slug: 'bertha-stone-butch-book-club',
      title: 'Book club · "Stone Butch Blues"',
      description: 'This month the book club reads Leslie Feinberg’s "Stone Butch Blues".',
      inDays: 14,
      hour: 17,
    },
  ],
  'queer-supper-club': [
    {
      slug: 'supper-club-summer-dinner',
      title: 'Summer dinner — the market decides',
      description: 'The next monthly seating: a seasonal menu for twelve, the market decides the courses.',
      inDays: 9,
      hour: 20,
    },
  ],
};

async function seedListings(
  manager: EntityManager,
  memberIdBySlug: Map<string, string>,
): Promise<void> {
  const listings = manager.getRepository(Listing);
  const reviews = manager.getRepository(ListingReview);
  const events = manager.getRepository(Event);

  const userId = (slug: string): string => {
    const id = memberIdBySlug.get(slug);
    if (!id) {
      throw new Error(
        `Cannot seed listings: no seeded member with slug "${slug}"`,
      );
    }
    return id;
  };

  for (const listing of LISTINGS) {
    const existing = await listings.findOne({ where: { slug: listing.slug } });
    if (existing) {
      continue;
    }

    const saved = await listings.save(
      listings.create({
        ref: listing.ref,
        slug: listing.slug,
        ownerId: userId(listing.ownerSlug),
        status: ListingStatus.Live,
        name: listing.name,
        cats: listing.cats,
        hood: listing.hood,
        price: listing.price,
        blurb: listing.blurb,
        tagline: listing.tagline,
        tags: listing.tags,
        goodFor: listing.goodFor,
        whatItIs: listing.whatItIs.map((text, index) => ({
          id: `wit-${index}`,
          text,
        })),
        address: listing.address,
        hoursNote: listing.hoursNote,
        // The prototype's gallery is caption cells (no images), so the seed's
        // captions map onto the four alt-text slots; `photos` stays empty.
        alt: {
          wide: listing.gallery[0] ?? '',
          d1: listing.gallery[1] ?? '',
          d2: listing.gallery[2] ?? '',
          vibe: listing.gallery[3] ?? '',
        },
        social: {
          instagram: listing.social.instagram ?? '',
          website: listing.social.website ?? '',
          email: listing.social.email ?? '',
          phone: listing.social.phone ?? '',
        },
        ownerName: listing.ownerName,
        ownerRole: listing.ownerRole,
        ownerBio: listing.ownerBio,
        // Seeded businesses are all community-owned / member-run, so link them
        // to their owner's profile — this is what surfaces the "queer-owned"
        // badge and "run by a member" line on the directory grid.
        linkToProfile: true,
        isPartneredWithQueerpulse: listing.isPartneredWithQueerpulse ?? false,
        spaceType: listing.spaceType ?? '',
        capacity: listing.capacity ?? null,
        hostNote: listing.hostNote ?? '',
      }),
    );

    const listingReviews = LISTING_REVIEWS[listing.slug] ?? [];
    for (const review of listingReviews) {
      await reviews.save(
        reviews.create({
          listingId: saved.id,
          reviewerId: null,
          reviewerName: review.name,
          byline: review.byline,
          stars: review.stars,
          text: review.text,
          helpful: review.helpful,
        }),
      );
    }

    const listingEvents = LISTING_EVENTS[listing.slug] ?? [];
    for (const listingEvent of listingEvents) {
      const startAt = new Date();
      startAt.setDate(startAt.getDate() + listingEvent.inDays);
      startAt.setHours(listingEvent.hour, 0, 0, 0);
      await events.save(
        events.create({
          hostId: userId(listing.ownerSlug),
          listingId: saved.id,
          slug: listingEvent.slug,
          title: listingEvent.title,
          description: listingEvent.description,
          startAt,
          timezone: 'Europe/Lisbon',
          venue: listing.name,
          status: EventStatus.Published,
          visibility: EventVisibility.Public,
        }),
      );
    }

    console.log(
      `Seeded listing ${listing.slug}` +
        (listing.isPartneredWithQueerpulse ? ' (partner space)' : '') +
        ` with ${listingReviews.length} reviews, ${listingEvents.length} events`,
    );
  }
}

// Task 6 (changemakers real-data plan): a handful of published Change Makers
// directory profiles so the live `/changemakers` page has real content during
// development, converted from the frontend mock
// `changemakerStories.part1.data.tsx` (JSX `lead`/`body` flattened to plain
// strings — the entity stores plain text, not ReactNode). Three distinct
// `cause` values so `causeAreas` > 1 on the computed stats.
interface ChangemakerSeedDefinition {
  slug: string;
  name: string;
  initials: string;
  cause: string;
  tint: ChangemakerTint;
  tags: string[];
  summary: string;
  impact: string[];
  byline: string;
  heroNote: string;
  lead: string;
  body: string[];
  pullQuoteText: string;
  pullQuoteCite: string;
  isFeatured: boolean;
  sortOrder: number;
}

const CHANGEMAKERS: ChangemakerSeedDefinition[] = [
  {
    slug: 'catarina-vaz',
    name: 'Catarina Vaz',
    initials: 'CV',
    cause: 'Housing Rights · Mouraria',
    tint: 'coral',
    tags: ['Housing', 'Organising', 'Policy'],
    summary:
      "When Catarina's neighbours started receiving eviction notices in 2022, she didn't wait for someone else to act. She knocked on every door, mapped every situation, and built a coalition that eventually made it to the Câmara Municipal. Today she runs Mouraria's most active queer residents' network.",
    impact: [
      'Helped 14 queer households navigate legal challenges to eviction notices',
      'Testified twice at Câmara Municipal on the impact of short-term rentals on queer residents',
      'Co-authoring a housing rights brief for LGBTQ+ people with ILGA Portugal',
    ],
    byline: 'Words by Marta Reis',
    heroNote: 'Catarina on her street in Mouraria',
    lead: "She turned a stack of eviction notices into a residents' coalition the city council could not ignore.",
    body: [
      'In the spring of 2022, three of Catarina\'s neighbours got the same letter within a week — a notice to vacate, dressed up in the language of "building works." She recognised it for what it was: the slow, legal pushing-out of the people who had made Mouraria what it is. Many of them were older, many were queer, and almost all had lived on the same street for decades.',
      'She could have signed a petition. Instead she started knocking on doors. Not to organise a protest — to map the situation. Who had received what, when, from which landlord, under which clause. By the end of the month she had a spreadsheet that did something no individual tenant could do alone: it showed a pattern.',
      'That spreadsheet became a coalition. The coalition became a delegation to the Câmara Municipal, where Catarina testified — twice — on how short-term rentals were hollowing out the neighbourhood\'s queer community. She is not a lawyer and has never claimed to be one. What she is, is impossible to brush aside, because she always arrives with the receipts.',
      "Today her residents' network is the most active in Mouraria. It runs a phone tree for anyone who gets a notice, a shared folder of documentation, and a standing relationship with ILGA Portugal's legal team. None of it existed three years ago. All of it exists because one person decided that the neighbourhood that raised us should still have room for us.",
      "We highlight Catarina because her work is the kind that rarely gets seen: patient, unglamorous, and built entirely on showing up for the people next door. She didn't wait to be qualified. She started, and the qualification followed.",
    ],
    pullQuoteText:
      'The neighbourhood that raised us should still have room for us.',
    pullQuoteCite: '— Catarina Vaz',
    isFeatured: true,
    sortOrder: 0,
  },
  {
    slug: 'jonas-ferreira',
    name: 'Jonas Ferreira',
    initials: 'JF',
    cause: 'Trans Healthcare',
    tint: 'jade',
    tags: ['Health', 'Advocacy', 'Policy'],
    summary:
      'Founded the "Saúde Trans" information project and has personally trained over 40 GPs in trans-affirming care. Pushing hard on public health system reform.',
    impact: [
      'Personally trained 40+ GPs in trans-affirming primary care',
      'Built "Saúde Trans", the plain-language guide most members send to their doctors',
      'Sits on a working group advising the SNS on trans care pathways',
    ],
    byline: 'Words by Catarina Vaz',
    heroNote: 'Jonas at a GP training session',
    lead: "He decided that the fifteen minutes trans patients spend explaining themselves should be the doctor's job to remove, not the patient's to endure.",
    body: [
      'Jonas started counting. Every appointment, every trans person he knew described the same tax: the first ten or fifteen minutes spent not on their health, but on explaining themselves — their identity, their history, their words — to a clinician who should already have known.',
      "So he built the thing that didn't exist: Saúde Trans, a plain-language resource that trans patients could hand to a GP, and that GPs could actually use. Not an academic paper. A practical guide — what to ask, what not to ask, what to write down, who to refer to.",
      'Then he did the harder thing. He started training doctors, one practice at a time. Over forty GPs have now sat through his session, which is less a lecture than a series of uncomfortable, useful corrections. Several of them now run clinics that members travel across the city to reach.',
      'He is not satisfied with individual clinics, though. Reform is the point. Jonas now sits on a working group advising the public health service on trans care pathways — the slow, bureaucratic, deeply unglamorous arena where the fifteen minutes actually get abolished for everyone, not just the people lucky enough to find a good doctor.',
      'We highlight Jonas because he turned a private frustration into a public protocol. He measured the harm, named it, and then did the patient work of removing it from the system itself.',
    ],
    pullQuoteText: "Explaining yourself shouldn't be the price of getting care.",
    pullQuoteCite: '— Jonas Ferreira',
    isFeatured: false,
    sortOrder: 1,
  },
  {
    slug: 'luisa-gomes',
    name: 'Luísa Gomes',
    initials: 'LG',
    cause: 'Arts & Culture',
    tint: 'coral',
    tags: ['Arts', 'Curating', 'Culture'],
    summary:
      'Programmed the first queer season at a major Lisbon museum and co-founded the Rainbow Arts Collective. Making queer art central, not marginal.',
    impact: [
      'Curated the first dedicated queer season at a major Lisbon museum',
      'Co-founded the Rainbow Arts Collective and its open-crit programme',
      'Mentors emerging queer artists into mainstream institutional shows',
    ],
    byline: 'Words by André Bento',
    heroNote: 'Luísa in the gallery, mid-install',
    lead: 'She refused the sidebar. Queer art, she insists, belongs in the main hall — and she has spent a decade putting it there.',
    body: [
      'For most of Luísa\'s career, "queer programming" in Lisbon meant a corner during Pride, a panel after hours, a side room. She found the arrangement quietly insulting — not because the work was bad, but because the placement said something about where it belonged.',
      "So when she finally had the keys, she programmed the first dedicated queer season at a major Lisbon museum — in the main galleries, in the main season, on the main posters. Not as a theme to be visited and left, but as part of the city's cultural record.",
      "Alongside the institutional work, she co-founded the Rainbow Arts Collective, which does the opposite job: it builds rooms from nothing, in borrowed spaces, for artists who don't yet have the keys. The two halves of her work feed each other — the collective is where the museum's next show often begins.",
      "What ties it together is a refusal of the margin. Luísa treats queer art as central to Lisbon's story, and then makes the institutions act as if that were obviously true.",
      "We highlight Luísa because changing what hangs on the main wall changes what a city thinks of itself. She didn't ask for a bigger sidebar. She moved the work to the centre.",
    ],
    pullQuoteText: "We're not a sidebar to this city. We're part of the main story.",
    pullQuoteCite: '— Luísa Gomes',
    isFeatured: false,
    sortOrder: 2,
  },
];

// The two curated hero stats (`peopleHelped`, `activeCampaigns`) that
// `toDirectoryStatsDTO` cannot compute from the profiles themselves — matches
// the frontend demo-mode figures in `useChangemakers.ts`'s `DEMO_STATS`
// (1.2k / 12) so live mode shows comparable numbers locally.
const CHANGEMAKER_DIRECTORY_SETTINGS = {
  peopleHelped: 1200,
  activeCampaigns: 12,
};

async function seedChangemakers(manager: EntityManager): Promise<void> {
  const changemakers = manager.getRepository(Changemaker);
  const settings = manager.getRepository(ChangemakerDirectorySettings);

  let insertedCount = 0;
  for (const definition of CHANGEMAKERS) {
    // Idempotent: skip if a changemaker with this slug already exists.
    const existing = await changemakers.findOne({
      where: { slug: definition.slug },
    });
    if (existing) {
      continue;
    }

    await changemakers.save(
      changemakers.create({
        slug: definition.slug,
        name: definition.name,
        initials: definition.initials,
        cause: definition.cause,
        tint: definition.tint,
        tags: definition.tags,
        summary: definition.summary,
        imageUrl: null,
        impact: definition.impact,
        byline: definition.byline,
        heroNote: definition.heroNote,
        lead: definition.lead,
        body: definition.body,
        pullQuoteText: definition.pullQuoteText,
        pullQuoteCite: definition.pullQuoteCite,
        status: ChangemakerStatus.Published,
        isFeatured: definition.isFeatured,
        sortOrder: definition.sortOrder,
        publishedAt: new Date(),
      }),
    );
    insertedCount += 1;
  }
  console.log(`Seeded ${insertedCount} changemakers`);

  // Idempotent: the settings row is a singleton keyed by CHANGEMAKER_SETTINGS_ID.
  const existingSettings = await settings.findOne({
    where: { id: CHANGEMAKER_SETTINGS_ID },
  });
  if (!existingSettings) {
    await settings.save(
      settings.create({
        id: CHANGEMAKER_SETTINGS_ID,
        peopleHelped: CHANGEMAKER_DIRECTORY_SETTINGS.peopleHelped,
        activeCampaigns: CHANGEMAKER_DIRECTORY_SETTINGS.activeCampaigns,
      }),
    );
    console.log('Seeded changemaker directory settings');
  }
}

async function seed(): Promise<void> {
  // Guard: the seed inserts fixture members and must never touch a production
  // database. Refuse to run when NODE_ENV signals production.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run the seed with NODE_ENV=production. The seed is for local/dev fixtures only.',
    );
  }

  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    entities: [
      User,
      Profile,
      Skill,
      BoardPost,
      Shaping,
      Activity,
      Group,
      GroupMembership,
      Vouch,
      Report,
      ModAuditLog,
      Community,
      CommunityMember,
      CommunityPost,
      CommunityPostReaction,
      CommunityPostReply,
      CommunityJoinRequest,
      Company,
      CompanyTeamMember,
      CompanyReview,
      Job,
      JobApplication,
      VolunteerOpportunity,
      VolunteerOpportunityTeam,
      VolunteerSignup,
      Partner,
      Listing,
      ListingReview,
      Event,
      Changemaker,
      ChangemakerDirectorySettings,
      HousingCoop,
      CoopJoinRequest,
    ],
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
  });
  await dataSource.initialize();
  try {
    await dataSource.transaction(async (manager) => {
      const users = manager.getRepository(User);
      const profiles = manager.getRepository(Profile);

      const groupRepo = manager.getRepository(Group);
      let devsGroup = await groupRepo.findOne({
        where: { slug: 'queer-devs-lisbon' },
      });
      if (!devsGroup) {
        devsGroup = await groupRepo.save(
          groupRepo.create({
            slug: 'queer-devs-lisbon',
            name: 'Queer Devs Lisbon',
          }),
        );
      }

      for (const m of MEMBERS) {
        // Idempotent: skip if a user with this googleId already exists.
        const existing = await users.findOne({
          where: { googleId: m.googleId },
        });
        if (existing) {
          continue;
        }
        const user = await users.save(
          users.create({
            googleId: m.googleId,
            email: m.email,
            status: m.status,
            activatedAt: m.status === UserStatus.Active ? new Date() : null,
          }),
        );
        await profiles.save(
          profiles.create({
            userId: user.id,
            slug: m.slug,
            firstName: m.firstName,
            lastName: m.lastName,
            pronouns: m.pronouns,
            tagline: m.tagline,
            location: m.location,
            visibility: m.visibility,
            tags: m.tags,
            openTo: m.openTo,
            avatarUrl: null,
            // Falls back to the column defaults (false / now()) for the
            // original 3 fixtures, which don't set these — tomas-mendes then
            // gets overridden by the special-case block below, matching its
            // prior behavior exactly.
            verified: m.verified ?? false,
            joinedAt: m.joinedAt ? new Date(m.joinedAt) : new Date(),
          }),
        );

        if (m.slug === 'tomas-mendes') {
          await manager.getRepository(Profile).update(
            { userId: user.id },
            {
              verified: true,
              now: 'Illustrating a zine about the neighbourhood.',
              joinedAt: new Date('2024-03-01T00:00:00.000Z'),
            },
          );
          await manager.getRepository(Skill).save([
            manager.getRepository(Skill).create({
              userId: user.id,
              name: 'Illustration',
              meta: 'Available · ink, risograph',
              position: 0,
            }),
          ]);
          await manager.getRepository(BoardPost).save([
            manager.getRepository(BoardPost).create({
              userId: user.id,
              kind: BoardKind.Offering,
              title: 'Cover art for community zines',
              slug: 'zine-covers',
              position: 0,
            }),
          ]);
          await manager.getRepository(Shaping).save([
            manager.getRepository(Shaping).create({
              userId: user.id,
              kind: ShapingKind.Film,
              title: 'Paris Is Burning',
              note: 'Chosen family is a craft.',
            }),
          ]);
          await manager.getRepository(Activity).save([
            manager.getRepository(Activity).create({
              userId: user.id,
              kind: ActivityKind.Event,
              title: "RSVP'd to Queer Poetry Night",
              sub: 'Anjos · Thursday',
              toLink: '/gatherings/queer-poetry-night',
              occurredAt: new Date('2026-06-20T18:00:00.000Z'),
            }),
          ]);
          await manager.getRepository(GroupMembership).save(
            manager.getRepository(GroupMembership).create({
              userId: user.id,
              groupId: devsGroup.id,
              role: 'Member',
            }),
          );
        }

        console.log(`Seeded member ${m.slug}`);
      }

      // Communities, companies, jobs, etc. are owned by / rostered with the
      // seeded active members above; resolve every member's userId by slug via
      // the Profile repo. (Originally just the first 3 fixtures — extended to
      // every seeded slug for Task C1's vouches/reports/memberships, which
      // reference the full member roster.)
      const memberIdBySlug = new Map<string, string>();
      for (const m of MEMBERS) {
        const profile = await profiles.findOne({ where: { slug: m.slug } });
        if (profile) {
          memberIdBySlug.set(m.slug, profile.userId);
        }
      }
      await seedCommunities(manager, memberIdBySlug);
      await seedLiveCommunityMemberships(manager, memberIdBySlug);
      await seedVouches(manager, memberIdBySlug);
      await seedReports(manager, memberIdBySlug);
      await seedCompanies(manager, memberIdBySlug);
      await seedJobs(manager, memberIdBySlug);
      await seedVolunteering(manager, memberIdBySlug);
      const partnerIdBySlug = await seedPartners(manager, memberIdBySlug);
      await backfillVolunteeringPartnerLinks(manager, partnerIdBySlug);
      await seedListings(manager, memberIdBySlug);
      await seedChangemakers(manager);
    });

    console.log('Seed complete.');
  } finally {
    await dataSource.destroy();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
