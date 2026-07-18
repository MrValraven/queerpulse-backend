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

      // Communities are owned by / rostered with the seeded active members
      // above; resolve their userIds by slug via the Profile repo.
      const memberIdBySlug = new Map<string, string>();
      for (const slug of ['tomas-mendes', 'ana-rocha', 'noa-silva']) {
        const profile = await profiles.findOne({ where: { slug } });
        if (profile) {
          memberIdBySlug.set(slug, profile.userId);
        }
      }
      await seedCommunities(manager, memberIdBySlug);
      await seedCompanies(manager, memberIdBySlug);
      await seedJobs(manager, memberIdBySlug);
      await seedVolunteering(manager, memberIdBySlug);
      const partnerIdBySlug = await seedPartners(manager, memberIdBySlug);
      await backfillVolunteeringPartnerLinks(manager, partnerIdBySlug);
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
