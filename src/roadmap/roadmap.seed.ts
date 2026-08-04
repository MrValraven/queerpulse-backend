import { EntityManager } from 'typeorm';
import {
  RoadmapColumn,
  RoadmapConfidence,
  RoadmapCost,
  RoadmapGuideStep,
  RoadmapItem,
  RoadmapPaidKind,
  RoadmapPriority,
  RoadmapSafetyStatus,
  RoadmapSlipEntry,
  ROADMAP_GUIDE_STEPS,
} from './entities/roadmap-item.entity';
import {
  RoadmapDeclineReason,
  RoadmapIdea,
  RoadmapIdeaStatus,
} from './entities/roadmap-idea.entity';
import { RoadmapItemDependency } from './entities/roadmap-item-dependency.entity';
import { RoadmapTeamMember } from './entities/roadmap-team-member.entity';
import { RoadmapAuditLog } from './entities/roadmap-audit-log.entity';
import type { HeroStat } from './entities/roadmap-settings.entity';
import { RoadmapSettings } from './entities/roadmap-settings.entity';

/**
 * Fixture transcribed from the frontend's
 * `queerpulse/src/features/marketing/roadmap.data.ts` (`HERO_STATS` /
 * `SHIPPED` / `BUILDING` / `PLANNED` / `TOP_IDEAS`), so `/about/roadmap`
 * renders unchanged once wired to `GET /roadmap`. Consumed directly by
 * `src/migrations/1785002000000-CreateRoadmap.ts`, which INSERTs these rows
 * when the table is created — there is no separate `pnpm run seed` step for
 * the BASE 14-item board (`ROADMAP_ITEMS`/`ROADMAP_IDEAS`/
 * `ROADMAP_HERO_STATS` below), which stays untouched by Task A8.
 *
 * Task A8 (`docs/superpowers/plans/2026-08-04-admin-roadmap-redesign.md`)
 * adds a SECOND, richer layer further down this file —
 * `ROADMAP_ADMIN_SEED_ITEMS` / `_PENDING_IDEAS` / `_NOT_BUILDING` / `_TEAM` /
 * `_AUDIT` / `_HERO_STATS` plus the `seedRoadmapAdminContent()` entry point —
 * transcribed from the Claude Design project's `qp-roadmap-data.js`
 * prototype fixture. That layer is deliberately wired into `pnpm run seed`
 * (`src/database/seed.ts`), NOT into a migration, for two reasons:
 *
 * 1. **Live `users` lookups.** Owners/team/audit actors are resolved by
 *    seeded member slug (`tiago-costa`, `mariana-reis`, `jo-silva`,
 *    `ana-duarte`, `vera-lopes` — added to `src/database/seed.ts`'s
 *    `MEMBERS`) via the same idempotent, repository-based idiom every other
 *    domain in that file uses (`seedGovernanceOverview`,
 *    `seedChangemakers`, …) — a migration can run before any such user
 *    exists, so a hand-rolled email/slug lookup inside a migration would be
 *    far more fragile than reusing the established seed-runner.
 * 2. **The Postgres enum-same-transaction restriction.** Five of the rich
 *    items use the new `'backlog'` `RoadmapColumn` value, added by
 *    `AddRoadmapAdminModel`'s `ALTER TYPE … ADD VALUE 'backlog'`. Postgres
 *    forbids *using* a new enum value inside the same transaction that added
 *    it (see that migration's own doc comment, point 1) — `data-source.ts`
 *    runs each migration in its own transaction, so a value added in
 *    `AddRoadmapAdminModel` cannot be written by more DML appended to that
 *    same migration. A `pnpm run seed` run happens strictly after all
 *    migrations have committed, so it has no such restriction.
 *
 * `seedRoadmapAdminContent()` is UPDATE-or-INSERT keyed on each item's
 * `name` (or `matchName`, for the one item whose name changed for editorial
 * fidelity — see `ROADMAP_ADMIN_SEED_ITEMS`'s doc): every one of the base
 * 14 items that has a design counterpart gets ENRICHED IN PLACE (its
 * DB-generated id — and therefore any `roadmap_votes` already cast against
 * it — never changes), rather than deleted and re-inserted. The two base
 * items with no design counterpart (`RSVP ticket`, `Offline archive`) are
 * left completely untouched. This is what "keep existing item ids stable"
 * means in practice: nothing here ever assigns/hardcodes a UUID (the schema
 * has no seed-time id input at all — every row's id is `uuid_generate_v4()`
 * DB-side), so the only real lever for stability is never dropping/
 * recreating a row that already exists.
 */

export interface SeedItem {
  column: RoadmapColumn;
  category: string;
  name: string;
  description: string;
  date?: string;
  stage?: string;
  eta?: string;
  progress?: number;
  votes?: number;
  requested?: boolean;
  hot?: boolean;
  sortOrder: number;
}

export interface SeedIdea {
  text: string;
  votes: number;
  sortOrder: number;
}

export const ROADMAP_HERO_STATS: HeroStat[] = [
  { label: '12 shipped this year', jade: true },
  { label: '4 in progress' },
  { label: '5 planned' },
];

export const ROADMAP_ITEMS: SeedItem[] = [
  // Shipped — sortOrder follows the order SHIPPED appears in roadmap.data.ts.
  {
    column: RoadmapColumn.Shipped,
    category: 'Gatherings',
    name: 'Gathering dashboard',
    description:
      'Live check-in and attendance management for hosts, including QR scanning and waitlist promotion.',
    date: 'May 2026',
    sortOrder: 0,
  },
  {
    column: RoadmapColumn.Shipped,
    category: 'Safety',
    name: 'Moderation queue',
    description:
      'Internal tools for reviewing member reports, assigning cases, and issuing decisions.',
    date: 'Apr 2026',
    requested: true,
    sortOrder: 1,
  },
  {
    column: RoadmapColumn.Shipped,
    category: 'Members',
    name: 'Connection requests',
    description:
      'Send, receive, accept and decline connection requests. Mutual connections view included.',
    date: 'Mar 2026',
    sortOrder: 2,
  },
  {
    column: RoadmapColumn.Shipped,
    category: 'Community',
    name: 'Badges & levels',
    description:
      'XP system, earned badges, member perks, and a redeem page for level bonuses.',
    date: 'Jun 2026',
    requested: true,
    sortOrder: 3,
  },
  {
    column: RoadmapColumn.Shipped,
    category: 'Gatherings',
    name: 'RSVP ticket',
    description:
      'Shareable post-RSVP confirmation with QR code, calendar integration, and waitlist state.',
    date: 'May 2026',
    sortOrder: 4,
  },
  // Building
  {
    column: RoadmapColumn.Building,
    category: 'Platform',
    name: 'Mobile app beta',
    description:
      'iOS and Android apps, starting with gatherings and messaging. Beta invites go to Level 4+ members first.',
    stage: 'In progress',
    eta: '~Q3 2026',
    progress: 60,
    sortOrder: 0,
  },
  {
    column: RoadmapColumn.Building,
    category: 'Content',
    name: 'Magazine contributor tools',
    description:
      'Drafting, editing, and publishing tools so members can write for the magazine directly.',
    stage: 'In progress',
    eta: '~Q3 2026',
    progress: 35,
    requested: true,
    sortOrder: 1,
  },
  {
    column: RoadmapColumn.Building,
    category: 'Gatherings',
    name: 'Map view for gatherings',
    description:
      'Browse upcoming events on a city map. Filter by date, type, and distance.',
    stage: 'Early design',
    eta: '~Q4 2026',
    progress: 20,
    sortOrder: 2,
  },
  {
    column: RoadmapColumn.Building,
    category: 'Community',
    name: 'Shared housing board',
    description:
      'A dedicated space for queer-safe housing listings and flatmate search, separate from the main feed.',
    stage: 'Research',
    eta: '~Q4 2026',
    progress: 15,
    requested: true,
    sortOrder: 3,
  },
  // Planned
  {
    column: RoadmapColumn.Planned,
    category: 'Community',
    name: 'Queer business directory',
    description:
      'A curated directory of queer-owned and affirming businesses in Lisbon and beyond.',
    votes: 142,
    hot: true,
    sortOrder: 0,
  },
  {
    column: RoadmapColumn.Planned,
    category: 'Members',
    name: 'Anonymous Q&A threads',
    description:
      'Ask questions anonymously within communities. No names — just honest answers.',
    votes: 98,
    sortOrder: 1,
  },
  {
    column: RoadmapColumn.Planned,
    category: 'Messaging',
    name: 'Group messaging',
    description:
      'Create threads with multiple members — for planning gatherings, projects, or just chatting.',
    votes: 76,
    sortOrder: 2,
  },
  {
    column: RoadmapColumn.Planned,
    category: 'Content',
    name: 'Reading groups',
    description:
      'Structured book and article reading groups with discussion threads and a shared reading schedule.',
    votes: 54,
    sortOrder: 3,
  },
  {
    column: RoadmapColumn.Planned,
    category: 'Platform',
    name: 'Offline archive',
    description:
      'Download your posts, connections, and data in a portable format. Your history, yours to keep.',
    votes: 41,
    sortOrder: 4,
  },
];

export const ROADMAP_IDEAS: SeedIdea[] = [
  { text: 'Event reminders via SMS', votes: 34, sortOrder: 0 },
  { text: 'Dark mode', votes: 29, sortOrder: 1 },
  { text: 'Sub-communities within communities', votes: 22, sortOrder: 2 },
  { text: 'Recurring gatherings (monthly series)', votes: 18, sortOrder: 3 },
  { text: 'Shared event costs / ticket splitting', votes: 15, sortOrder: 4 },
];

// Seeded ideas are all pre-published (they mirror the frontend's already-live
// `TOP_IDEAS`), not `pending` review.
export const ROADMAP_IDEA_STATUS_PUBLISHED = RoadmapIdeaStatus.Published;

// ============================================================================
// Task A8 — rich admin-board content (`pnpm run seed`, not a migration; see
// the file-level doc comment above for why). Transcribed from the Claude
// Design project's `qp-roadmap-data.js` prototype fixture (SEED_ITEMS /
// SEED_IDEAS / SEED_NB / SEED_TEAM / SEED_STATS / SEED_AUDIT).
// ============================================================================

/** Ergonomic authoring shape for a seed item's `guide` — `trueSteps` lists
 *  only the steps that are checked off; `buildGuideSteps()` below expands it
 *  to the full `Record<RoadmapGuideStep, boolean>` the entity requires. */
export interface RoadmapAdminSeedGuide {
  reviewer: string;
  credential: string;
  reVerifyBy: string | null;
  languages: { en: boolean; pt: boolean; br: boolean };
  trueSteps: RoadmapGuideStep[];
}

export interface RoadmapAdminSeedItem {
  /** Final `name` to write. */
  name: string;
  /** Set only when this item's name differs from an EXISTING base-seed row's
   *  name (the lookup key) — currently only "Queer business directory",
   *  renamed to "Queer-owned business directory" for editorial fidelity to
   *  the design fixture. Every other item is looked up (and, for new items,
   *  created) by `name` itself. */
  matchName?: string;
  column: RoadmapColumn;
  category: string;
  description: string;
  date?: string | null;
  stage?: string | null;
  eta?: string | null;
  progress?: number | null;
  votes: number;
  requested?: boolean;
  hot?: boolean;
  publicNote?: string | null;
  targetQuarter?: string | null;
  priority?: RoadmapPriority;
  confidence?: RoadmapConfidence;
  committed?: boolean;
  isPublic?: boolean;
  notified?: boolean;
  spikeFlag?: boolean;
  safetyStatus?: RoadmapSafetyStatus;
  blockedBy?: string | null;
  blockedWhy?: string | null;
  paidKind?: RoadmapPaidKind;
  weeklyHours?: number;
  cost?: RoadmapCost;
  /** One of `ROADMAP_ADMIN_SEED_TEAM`'s `slug`s, or `null`/omitted for the
   *  design fixture's "un" (unassigned) owner. Resolved to a real `users.id`
   *  at seed time via `memberIdBySlug` — best-effort: an unresolved slug
   *  (the member fixture hasn't been added, or `pnpm run seed` ran before
   *  Task A8's 5 new `MEMBERS` entries existed) leaves `ownerId` `null`
   *  rather than failing the whole seed run. */
  ownerSlug?: string | null;
  slips?: RoadmapSlipEntry[];
  guide?: RoadmapAdminSeedGuide | null;
  /** Names of other seed items this one depends on (resolved after every
   *  item has been upserted, so forward references — e.g. "Peer mentoring
   *  matches" depending on "Vouch chain visibility", inserted earlier in
   *  this same array — work either order). */
  dependsOnNames?: string[];
}

// Grouped by column, matching the design fixture's own ordering. Items that
// already exist in the base 14 (matched by `name`/`matchName`) are enriched
// in place; the rest are new inserts. `RSVP ticket` and `Offline archive`
// (the two base items with no design counterpart) are intentionally absent
// from this array — they're left untouched.
export const ROADMAP_ADMIN_SEED_ITEMS: RoadmapAdminSeedItem[] = [
  // --- Shipped ---------------------------------------------------------
  {
    name: 'Gathering dashboard',
    column: RoadmapColumn.Shipped,
    category: 'Gatherings',
    description:
      'Live check-in and attendance management for hosts, including QR scanning and waitlist promotion.',
    date: 'May 2026',
    progress: 100,
    votes: 88,
    publicNote: 'Hosting, without the spreadsheet.',
    targetQuarter: 'Q3 2026',
    priority: RoadmapPriority.P1,
    confidence: RoadmapConfidence.Likely,
    committed: true,
    isPublic: true,
    notified: true,
    ownerSlug: 'mariana-reis',
  },
  {
    name: 'Moderation queue',
    column: RoadmapColumn.Shipped,
    category: 'Safety',
    description:
      'Internal tools for reviewing member reports, assigning cases, and issuing decisions.',
    date: 'Apr 2026',
    progress: 100,
    votes: 71,
    requested: true,
    publicNote: 'Safety as infrastructure, not a policy page.',
    targetQuarter: 'Q3 2026',
    priority: RoadmapPriority.P0,
    confidence: RoadmapConfidence.Likely,
    committed: true,
    isPublic: true,
    notified: true,
    ownerSlug: 'tiago-costa',
  },
  {
    name: 'Connection requests',
    column: RoadmapColumn.Shipped,
    category: 'Members',
    description:
      'Send, receive, accept and decline connection requests. Mutual connections view included.',
    date: 'Mar 2026',
    progress: 100,
    votes: 56,
    publicNote: 'Introductions, not cold DMs.',
    targetQuarter: 'Q3 2026',
    priority: RoadmapPriority.P1,
    confidence: RoadmapConfidence.Likely,
    committed: true,
    isPublic: true,
    notified: true,
    ownerSlug: 'jo-silva',
  },
  {
    name: 'Badges & levels',
    column: RoadmapColumn.Shipped,
    category: 'Community',
    description:
      'XP system, earned badges, member perks, and a redeem page for level bonuses.',
    date: 'Jun 2026',
    progress: 100,
    votes: 34,
    // The design fixture doesn't flag this one "requested" or "committed" —
    // unlike its four shipped siblings, it wasn't a publicly promised date.
    requested: false,
    publicNote: 'Recognition for the people who build this.',
    priority: RoadmapPriority.P2,
    confidence: RoadmapConfidence.Likely,
    committed: false,
    isPublic: false,
    ownerSlug: 'ana-duarte',
  },
  {
    name: 'Safe spaces map',
    column: RoadmapColumn.Shipped,
    category: 'Safety',
    description:
      'Member-sourced map of physically and socially safe venues, filtered by verified tags.',
    date: 'Jul 2026',
    progress: 100,
    votes: 112,
    requested: true,
    publicNote: 'Where you can exhale.',
    targetQuarter: 'Q3 2026',
    priority: RoadmapPriority.P0,
    confidence: RoadmapConfidence.Likely,
    committed: true,
    isPublic: true,
    notified: true,
    safetyStatus: 2,
    ownerSlug: 'tiago-costa',
  },

  // --- Building ----------------------------------------------------------
  {
    name: 'Vetted therapist directory',
    column: RoadmapColumn.Building,
    category: 'Resources',
    description:
      "Licensed, WPATH-informed therapists reviewed by members who've actually seen them — vetted before listing, not just self-submitted.",
    stage: 'In progress',
    eta: '~Q3 2026',
    progress: 60,
    votes: 214,
    requested: true,
    publicNote:
      'A directory of therapists our members have actually sat with — not a Google list.',
    targetQuarter: 'Q3 2026',
    priority: RoadmapPriority.P0,
    confidence: RoadmapConfidence.Likely,
    committed: true,
    isPublic: true,
    paidKind: RoadmapPaidKind.Paid,
    weeklyHours: 12,
    cost: RoadmapCost.Funded,
    safetyStatus: 2,
    ownerSlug: 'mariana-reis',
    guide: {
      reviewer: 'Dr. Inês Bragança',
      credential: 'Clinical psychologist, WPATH-trained',
      reVerifyBy: '2027-02-01',
      languages: { en: true, pt: true, br: false },
      trueSteps: ['research', 'draft', 'lived'],
    },
  },
  {
    name: 'Trans health guide',
    column: RoadmapColumn.Building,
    category: 'Resources',
    description:
      'Endocrinology-reviewed guide to hormone therapy access, dosing, and pathways in the Portuguese public and private systems.',
    stage: 'In progress',
    eta: '~Q4 2026',
    progress: 45,
    votes: 198,
    requested: true,
    publicNote: 'The guide we all wish someone had handed us.',
    targetQuarter: 'Q4 2026',
    priority: RoadmapPriority.P0,
    confidence: RoadmapConfidence.Maybe,
    committed: true,
    isPublic: true,
    weeklyHours: 6,
    cost: RoadmapCost.Needs,
    safetyStatus: 2,
    ownerSlug: 'ana-duarte',
    slips: [
      {
        from: 'Q3 2026',
        to: 'Q4 2026',
        reason:
          'Clinical reviewer availability — we would rather be late than wrong on dosages and pathways.',
        movedByName: 'Ana Duarte',
        movedAt: '2026-07-12T00:00:00.000Z',
      },
    ],
    guide: {
      reviewer: 'Dr. Miguel Antunes',
      credential: 'Endocrinologist, CHULN',
      reVerifyBy: '2027-01-15',
      languages: { en: true, pt: true, br: true },
      trueSteps: ['research', 'draft'],
    },
  },
  {
    name: 'Honest employer reviews',
    column: RoadmapColumn.Building,
    category: 'Economy',
    description:
      'Structured, named employer reviews from members — held pending a legal read on defamation exposure before launch.',
    stage: 'Blocked',
    eta: '~Q4 2026',
    progress: 25,
    votes: 189,
    requested: true,
    publicNote: 'Which Lisbon employers are actually safe to be out at.',
    targetQuarter: 'Q4 2026',
    priority: RoadmapPriority.P1,
    confidence: RoadmapConfidence.Maybe,
    // Gated by `safetyStatus: 1` (review required) — a safety-gated item
    // cannot also be public (the admin service's safety guard rejects any
    // update once both are true, so a seeded row with both would become
    // permanently uneditable via the admin API). Also matches this item's
    // own "Blocked, waiting on legal opinion" narrative.
    isPublic: false,
    paidKind: RoadmapPaidKind.Paid,
    weeklyHours: 10,
    cost: RoadmapCost.Small,
    safetyStatus: 1,
    spikeFlag: true,
    blockedBy: 'Sofia Melo (legal)',
    blockedWhy:
      'Defamation exposure on named-employer reviews — waiting on a written opinion before we open it up.',
    ownerSlug: 'jo-silva',
  },
  {
    name: 'Vouch chain visibility',
    column: RoadmapColumn.Building,
    category: 'Safety',
    description:
      'Surfaces the vouch chain that got a member into the platform, so trust is visible instead of implicit.',
    stage: 'In progress',
    eta: '~Q3 2026',
    progress: 75,
    votes: 64,
    publicNote: 'See the door you walked through.',
    targetQuarter: 'Q3 2026',
    priority: RoadmapPriority.P0,
    confidence: RoadmapConfidence.Likely,
    committed: true,
    isPublic: true,
    paidKind: RoadmapPaidKind.Paid,
    weeklyHours: 14,
    cost: RoadmapCost.Funded,
    safetyStatus: 2,
    ownerSlug: 'tiago-costa',
  },
  {
    name: 'Mobile app beta',
    column: RoadmapColumn.Building,
    category: 'Platform',
    description:
      'iOS and Android apps, starting with gatherings and messaging. Beta invites go to Level 4+ members first.',
    stage: 'In progress',
    eta: '~Q3 2026',
    progress: 60,
    votes: 167,
    publicNote: 'The room, in your pocket.',
    targetQuarter: 'Q3 2026',
    priority: RoadmapPriority.P0,
    confidence: RoadmapConfidence.Likely,
    committed: true,
    isPublic: true,
    paidKind: RoadmapPaidKind.Paid,
    weeklyHours: 18,
    cost: RoadmapCost.Funded,
    ownerSlug: 'jo-silva',
    slips: [
      {
        from: 'Q2 2026',
        to: 'Q3 2026',
        reason:
          'App Store review flagged the invite-only flow twice. We rebuilt onboarding rather than open the doors.',
        movedByName: 'Jo Silva',
        movedAt: '2026-05-02T00:00:00.000Z',
      },
    ],
  },
  {
    name: 'Magazine contributor tools',
    column: RoadmapColumn.Building,
    category: 'Content',
    description:
      'Drafting, editing, and publishing tools so members can write for the magazine directly.',
    stage: 'In progress',
    eta: '~Q3 2026',
    progress: 35,
    votes: 59,
    requested: true,
    publicNote: 'Get paid to write for us.',
    targetQuarter: 'Q3 2026',
    priority: RoadmapPriority.P2,
    confidence: RoadmapConfidence.Maybe,
    isPublic: true,
    weeklyHours: 6,
    cost: RoadmapCost.Small,
    ownerSlug: 'ana-duarte',
  },
  {
    name: 'Map view for gatherings',
    column: RoadmapColumn.Building,
    category: 'Gatherings',
    description:
      'Browse upcoming events on a city map. Filter by date, type, and distance.',
    stage: 'Early design',
    eta: '~Q4 2026',
    progress: 20,
    votes: 73,
    publicNote: 'What is on near you, this week.',
    targetQuarter: 'Q4 2026',
    priority: RoadmapPriority.P2,
    confidence: RoadmapConfidence.Maybe,
    isPublic: true,
    weeklyHours: 4,
    ownerSlug: 'mariana-reis',
    dependsOnNames: ['Safe spaces map'],
  },

  // --- Planned -------------------------------------------------------------
  {
    name: 'Portuguese legal rights guide',
    column: RoadmapColumn.Planned,
    category: 'Resources',
    description:
      'Plain-language guide to Portuguese legal protections and processes — name/gender marker changes, anti-discrimination law, housing and employment rights.',
    votes: 176,
    requested: true,
    publicNote: 'Your rights here, in words that make sense.',
    targetQuarter: 'Q4 2026',
    priority: RoadmapPriority.P1,
    confidence: RoadmapConfidence.Maybe,
    committed: true,
    // Gated by `safetyStatus: 1` (review required) — see the same note on
    // "Honest employer reviews" above: a safety-gated item must not also be
    // public, or the admin safety guard rejects every future edit.
    isPublic: false,
    weeklyHours: 5,
    cost: RoadmapCost.Needs,
    safetyStatus: 1,
    ownerSlug: 'vera-lopes',
    guide: {
      reviewer: 'Sofia Melo',
      credential: 'Lawyer, ILGA Portugal',
      reVerifyBy: '2027-03-01',
      languages: { en: true, pt: true, br: false },
      trueSteps: ['research'],
    },
  },
  {
    name: 'Queer-owned business directory',
    matchName: 'Queer business directory',
    column: RoadmapColumn.Planned,
    category: 'Economy',
    description:
      'A curated directory of queer-owned and affirming businesses in Lisbon and beyond.',
    votes: 142,
    hot: true,
    requested: true,
    publicNote: 'Spend your money where it comes back to us.',
    targetQuarter: 'Q4 2026',
    priority: RoadmapPriority.P1,
    confidence: RoadmapConfidence.Likely,
    isPublic: true,
    weeklyHours: 6,
    ownerSlug: null,
  },
  {
    name: 'Peer mentoring matches',
    column: RoadmapColumn.Planned,
    category: 'Members',
    description:
      'Matches newer members with someone a few steps further along, opt-in and time-boxed.',
    votes: 131,
    requested: true,
    publicNote: 'Someone a few steps ahead of you, once a month.',
    targetQuarter: 'Q1 2027',
    priority: RoadmapPriority.P1,
    confidence: RoadmapConfidence.Maybe,
    isPublic: true,
    weeklyHours: 8,
    paidKind: RoadmapPaidKind.Paid,
    ownerSlug: 'mariana-reis',
    dependsOnNames: ['Vouch chain visibility'],
  },
  {
    name: 'Sexual health guide',
    column: RoadmapColumn.Planned,
    category: 'Resources',
    description:
      'Testing sites, PrEP access, and harm-reduction basics reviewed by a sexual health nurse.',
    votes: 124,
    requested: true,
    publicNote: 'Testing, PrEP and care — without the lecture.',
    targetQuarter: 'Q4 2026',
    priority: RoadmapPriority.P1,
    confidence: RoadmapConfidence.Likely,
    committed: true,
    isPublic: true,
    weeklyHours: 5,
    safetyStatus: 2,
    ownerSlug: 'ana-duarte',
    guide: {
      reviewer: 'Enfermeira Cláudia Pinto',
      credential: 'Sexual health nurse, CheckpointLX',
      reVerifyBy: '2027-02-01',
      languages: { en: true, pt: true, br: false },
      trueSteps: ['research'],
    },
  },
  {
    name: 'Anonymous Q&A threads',
    column: RoadmapColumn.Planned,
    category: 'Members',
    description:
      'Ask questions anonymously within communities. No names — just honest answers.',
    votes: 98,
    requested: true,
    publicNote: 'Ask the thing you cannot sign your name to.',
    targetQuarter: 'Q4 2026',
    priority: RoadmapPriority.P1,
    confidence: RoadmapConfidence.Maybe,
    // Gated by `safetyStatus: 1` (review required) — same invariant as
    // "Honest employer reviews"/"Portuguese legal rights guide" above.
    isPublic: false,
    safetyStatus: 1,
    ownerSlug: null,
  },
  {
    name: 'Group messaging',
    column: RoadmapColumn.Planned,
    category: 'Messaging',
    description:
      'Create threads with multiple members — for planning gatherings, projects, or just chatting.',
    votes: 76,
    publicNote: 'Small rooms inside the room.',
    targetQuarter: 'Q1 2027',
    priority: RoadmapPriority.P2,
    confidence: RoadmapConfidence.Maybe,
    isPublic: true,
    ownerSlug: null,
  },
  {
    name: 'Reading groups',
    column: RoadmapColumn.Planned,
    category: 'Content',
    description:
      'Structured book and article reading groups with discussion threads and a shared reading schedule. Currently scoped to the "Queer Creatives" community.',
    votes: 54,
    publicNote: 'One book, one room, once a month.',
    targetQuarter: 'Q1 2027',
    priority: RoadmapPriority.P3,
    confidence: RoadmapConfidence.Hoping,
    isPublic: true,
    ownerSlug: null,
  },

  // --- Backlog ---------------------------------------------------------
  {
    name: 'Mental health guide',
    column: RoadmapColumn.Backlog,
    category: 'Resources',
    description:
      'Crisis and non-crisis mental health resources, from a 3am hotline to ongoing local support.',
    votes: 118,
    requested: true,
    publicNote: 'What to do at 3am, and what to do next month.',
    targetQuarter: 'Q1 2027',
    priority: RoadmapPriority.P1,
    confidence: RoadmapConfidence.Hoping,
    isPublic: true,
    ownerSlug: null,
    guide: {
      reviewer: '',
      credential: '',
      reVerifyBy: '2027-06-01',
      languages: { en: false, pt: false, br: false },
      trueSteps: [],
    },
  },
  {
    name: 'Coming out guide',
    column: RoadmapColumn.Backlog,
    category: 'Resources',
    description:
      'A resource, not a script — options and considerations for members thinking about coming out, including not doing it.',
    votes: 97,
    requested: true,
    publicNote: 'No single script. Including the option of not doing it.',
    targetQuarter: 'Q1 2027',
    priority: RoadmapPriority.P2,
    confidence: RoadmapConfidence.Hoping,
    isPublic: true,
    ownerSlug: null,
    guide: {
      reviewer: '',
      credential: '',
      reVerifyBy: null,
      languages: { en: false, pt: false, br: false },
      trueSteps: [],
    },
  },
  {
    name: 'Shared housing board',
    column: RoadmapColumn.Backlog,
    category: 'Community',
    description:
      'A dedicated space for queer-safe housing listings and flatmate search, separate from the main feed.',
    // Reclassified from `building` to `backlog` for design fidelity — a
    // backlog card carries no `progress`/`stage`/`eta` (see the entity's
    // "Building only" doc comments), so this UPDATE clears them.
    progress: null,
    votes: 161,
    requested: true,
    publicNote: null,
    targetQuarter: null,
    priority: RoadmapPriority.P1,
    confidence: RoadmapConfidence.Hoping,
    isPublic: false,
    safetyStatus: 1,
    spikeFlag: true,
    blockedBy: 'Trust & Safety',
    blockedWhy:
      'Scam and predation risk on housing posts. Needs identity gating and a reporting path before it can exist publicly.',
    ownerSlug: null,
  },
  {
    name: 'Sliding-scale membership',
    column: RoadmapColumn.Backlog,
    category: 'Economy',
    description:
      "Income-based membership pricing so cost isn't a barrier to joining.",
    votes: 87,
    requested: true,
    publicNote: null,
    targetQuarter: null,
    priority: RoadmapPriority.P1,
    confidence: RoadmapConfidence.Maybe,
    isPublic: false,
    cost: RoadmapCost.Needs,
    ownerSlug: 'tiago-costa',
  },
  {
    name: 'Community governance votes',
    column: RoadmapColumn.Backlog,
    category: 'Community',
    description: 'Structured member votes on platform policy and priorities.',
    votes: 43,
    publicNote: 'You get a say in the rules.',
    targetQuarter: 'Q2 2027',
    priority: RoadmapPriority.P3,
    confidence: RoadmapConfidence.Hoping,
    isPublic: true,
    ownerSlug: null,
  },
];

// Member-submitted ideas awaiting a moderator decision (the admin Ideas
// queue) — distinct from `ROADMAP_IDEAS` above, which are already-published
// "Top ideas". `duplicateOfName` resolves to `duplicateOfItemId` against
// `ROADMAP_ADMIN_SEED_ITEMS`'s final `name`s once those are upserted.
export interface RoadmapAdminSeedPendingIdea {
  text: string;
  category: string;
  votes: number;
  note: string;
  duplicateOfName?: string;
}

export const ROADMAP_ADMIN_SEED_PENDING_IDEAS: RoadmapAdminSeedPendingIdea[] = [
  {
    text: 'Trans-friendly barber & salon list',
    category: 'Resources',
    votes: 64,
    note: 'Submitted by Rui M. — "Getting a haircut without being misgendered is harder than it sounds."',
    duplicateOfName: 'Queer-owned business directory',
  },
  {
    text: 'Buddy system for first gatherings',
    category: 'Gatherings',
    votes: 51,
    note: 'Submitted by Sofia A. — "Walking in alone the first time is the hardest part."',
  },
  {
    text: 'Asylum & residency resource hub',
    category: 'Resources',
    votes: 47,
    note: 'Submitted anonymously — "For queer migrants navigating AIMA. Nothing accurate exists in English." Flagged as a possible spike.',
    duplicateOfName: 'Portuguese legal rights guide',
  },
  {
    text: 'Skill swap between members',
    category: 'Economy',
    votes: 38,
    note: 'Submitted by Nuno F. — "I will do your brand identity, you do my accounting."',
  },
  {
    text: 'Sober-friendly gathering tag',
    category: 'Gatherings',
    votes: 33,
    note: 'Submitted by Beatriz L. — "Not everything has to happen in a bar."',
  },
];

// The public "Not building this, and why" section — dismissed ideas with a
// member-facing decline reason/note.
export interface RoadmapAdminSeedNotBuildingIdea {
  text: string;
  category: string;
  declineReason: RoadmapDeclineReason;
  declineNote: string;
  votes: number;
}

export const ROADMAP_ADMIN_SEED_NOT_BUILDING: RoadmapAdminSeedNotBuildingIdea[] =
  [
    {
      text: 'Public member profiles',
      category: 'Members',
      declineReason: 'scope',
      declineNote:
        'Public profiles turn a vouched room into a directory strangers can scrape. The whole point is that you cannot see in from outside.',
      votes: 29,
    },
    {
      text: 'Dating / matching feature',
      category: 'Members',
      declineReason: 'harm',
      declineNote:
        'Mixing professional networking with dating puts people who are out at work in an impossible position. There are good apps for this; we are not one.',
      votes: 74,
    },
  ];

// The Capacity view roster. `slug` matches a `MEMBERS` entry's `slug` in
// `src/database/seed.ts` (Task A8 added the 5 below it) — resolved via that
// file's `memberIdBySlug` map, same as every other domain's seed function.
export interface RoadmapAdminSeedTeamMember {
  slug: string;
  role: string;
  weeklyCapHours: number;
  paid: boolean;
  sortOrder: number;
}

export const ROADMAP_ADMIN_SEED_TEAM: RoadmapAdminSeedTeamMember[] = [
  {
    slug: 'tiago-costa',
    role: 'Trust & Safety lead',
    weeklyCapHours: 20,
    paid: true,
    sortOrder: 0,
  },
  {
    slug: 'mariana-reis',
    role: 'Community',
    weeklyCapHours: 16,
    paid: true,
    sortOrder: 1,
  },
  {
    slug: 'jo-silva',
    role: 'Product & build',
    weeklyCapHours: 24,
    paid: true,
    sortOrder: 2,
  },
  {
    slug: 'ana-duarte',
    role: 'Editorial',
    weeklyCapHours: 8,
    paid: false,
    sortOrder: 3,
  },
  {
    slug: 'vera-lopes',
    role: 'Volunteer researcher',
    weeklyCapHours: 6,
    paid: false,
    sortOrder: 4,
  },
];

export interface RoadmapAdminSeedAuditEntry {
  /** `slug` of the actor, or `null` for a system-attributed entry. */
  actorSlug: string | null;
  actorLabel: string;
  action: string;
  createdAt: string;
}

export const ROADMAP_ADMIN_SEED_AUDIT: RoadmapAdminSeedAuditEntry[] = [
  {
    actorSlug: 'jo-silva',
    actorLabel: 'Jo Silva',
    action:
      'Moved "Honest employer reviews" to Blocked — waiting on legal opinion',
    createdAt: '2026-08-03T08:12:00.000Z',
  },
  {
    actorSlug: 'ana-duarte',
    actorLabel: 'Ana Duarte',
    action: 'Marked "Trans health guide" draft step complete',
    createdAt: '2026-08-02T17:40:00.000Z',
  },
  {
    actorSlug: 'ana-duarte',
    actorLabel: 'Ana Duarte',
    action: 'Target moved Q3 2026 → Q4 2026 on "Trans health guide"',
    createdAt: '2026-07-12T11:05:00.000Z',
  },
  {
    actorSlug: 'jo-silva',
    actorLabel: 'Jo Silva',
    action: 'Target moved Q2 2026 → Q3 2026 on "Mobile app beta"',
    createdAt: '2026-05-02T09:31:00.000Z',
  },
];

// Replaces (not merges with) the base `ROADMAP_HERO_STATS` singleton row —
// the admin Hero Stats view (Task C8) edits exactly these 4 tiles.
export const ROADMAP_ADMIN_SEED_HERO_STATS: HeroStat[] = [
  {
    label: 'Resource guides live',
    value: '6',
    note: 'Counts published guides only',
    jade: true,
  },
  {
    label: 'Members vouched in',
    value: '8,412',
    note: 'Rounded down, updated nightly',
  },
  {
    label: 'Shipped this quarter',
    value: '5',
    note: 'Auto-counted from the board',
  },
  {
    label: 'Member ideas on the board',
    value: '11',
    note: 'Ideas promoted to board items',
  },
];

function buildGuideSteps(
  trueSteps: RoadmapGuideStep[],
): Record<RoadmapGuideStep, boolean> {
  const steps = {} as Record<RoadmapGuideStep, boolean>;
  for (const step of ROADMAP_GUIDE_STEPS) {
    steps[step] = trueSteps.includes(step);
  }
  return steps;
}

// UPDATE-or-INSERT every rich item, keyed on `matchName ?? name`. Existing
// rows (the base 14's design counterparts) are enriched via a targeted
// `update()` that never touches `sortOrder` — new rows are appended after
// the current max `sortOrder` in their column, mirroring
// `RoadmapAdminService.duplicateItem`'s idiom. Returns a `name -> id` map
// used by the deps/idea-duplicate resolution passes below.
async function seedRoadmapAdminItems(
  manager: EntityManager,
  memberIdBySlug: Map<string, string>,
): Promise<Map<string, string>> {
  const items = manager.getRepository(RoadmapItem);
  const nameToId = new Map<string, string>();

  for (const seedItem of ROADMAP_ADMIN_SEED_ITEMS) {
    const lookupName = seedItem.matchName ?? seedItem.name;
    const existing = await items.findOne({ where: { name: lookupName } });

    const ownerId = seedItem.ownerSlug
      ? (memberIdBySlug.get(seedItem.ownerSlug) ?? null)
      : null;

    const guide = seedItem.guide
      ? {
          reviewer: seedItem.guide.reviewer,
          credential: seedItem.guide.credential,
          reVerifyBy: seedItem.guide.reVerifyBy,
          languages: seedItem.guide.languages,
          steps: buildGuideSteps(seedItem.guide.trueSteps),
        }
      : null;

    const fields = {
      name: seedItem.name,
      category: seedItem.category,
      column: seedItem.column,
      description: seedItem.description,
      date: seedItem.date ?? null,
      stage: seedItem.stage ?? null,
      eta: seedItem.eta ?? null,
      progress: seedItem.progress ?? null,
      votes: seedItem.votes,
      requested: seedItem.requested ?? false,
      hot: seedItem.hot ?? false,
      publicNote: seedItem.publicNote ?? null,
      targetQuarter: seedItem.targetQuarter ?? null,
      priority: seedItem.priority ?? RoadmapPriority.P2,
      confidence: seedItem.confidence ?? RoadmapConfidence.Maybe,
      committed: seedItem.committed ?? false,
      isPublic: seedItem.isPublic ?? true,
      notified: seedItem.notified ?? false,
      spikeFlag: seedItem.spikeFlag ?? false,
      safetyStatus: seedItem.safetyStatus ?? 0,
      blockedBy: seedItem.blockedBy ?? null,
      blockedWhy: seedItem.blockedWhy ?? null,
      paidKind: seedItem.paidKind ?? RoadmapPaidKind.Volunteer,
      weeklyHours: seedItem.weeklyHours ?? 0,
      cost: seedItem.cost ?? RoadmapCost.None,
      ownerId,
      slips: seedItem.slips ?? [],
      guide,
    };

    if (existing) {
      await items.update({ id: existing.id }, fields);
      nameToId.set(seedItem.name, existing.id);
    } else {
      const maxOrderRow = await items
        .createQueryBuilder('item')
        .select('MAX(item.sortOrder)', 'max')
        .where('item.column = :column', { column: seedItem.column })
        .getRawOne<{ max: number | null }>();
      const created = await items.save(
        items.create({
          ...fields,
          archived: false,
          sortOrder: (maxOrderRow?.max ?? -1) + 1,
        }),
      );
      nameToId.set(seedItem.name, created.id);
    }
  }

  return nameToId;
}

// One directed edge per `dependsOnNames` entry, idempotent per (item,
// dependsOn) pair — mirrors `RoadmapAdminService.updateDeps`'s uniqueness
// idiom. Silently skips a name that didn't resolve (e.g. `dependsOnNames`
// pointing at an item not present in this seed) rather than failing the run.
async function seedRoadmapAdminDependencies(
  manager: EntityManager,
  nameToId: Map<string, string>,
): Promise<void> {
  const deps = manager.getRepository(RoadmapItemDependency);
  let insertedCount = 0;

  for (const seedItem of ROADMAP_ADMIN_SEED_ITEMS) {
    if (!seedItem.dependsOnNames?.length) continue;
    const itemId = nameToId.get(seedItem.name);
    if (!itemId) continue;

    for (const dependsOnName of seedItem.dependsOnNames) {
      const dependsOnId = nameToId.get(dependsOnName);
      if (!dependsOnId) continue;

      const existing = await deps.findOne({ where: { itemId, dependsOnId } });
      if (existing) continue;

      await deps.save(deps.create({ itemId, dependsOnId }));
      insertedCount += 1;
    }
  }

  console.log(`Seeded ${insertedCount} roadmap item dependencies`);
}

// Idempotent per idea `text` (no natural unique constraint on the column,
// same idiom `seedOrgTiers`/`seedGovernanceOverview` use for their own
// natural keys). Pending ideas' `duplicateOfName` resolves against the item
// `nameToId` map built above.
async function seedRoadmapAdminIdeas(
  manager: EntityManager,
  nameToId: Map<string, string>,
): Promise<void> {
  const ideas = manager.getRepository(RoadmapIdea);

  const maxOrderRow = await ideas
    .createQueryBuilder('idea')
    .select('MAX(idea.sortOrder)', 'max')
    .getRawOne<{ max: number | null }>();
  let nextSortOrder = (maxOrderRow?.max ?? -1) + 1;
  let insertedCount = 0;

  for (const pendingIdea of ROADMAP_ADMIN_SEED_PENDING_IDEAS) {
    const existing = await ideas.findOne({
      where: { text: pendingIdea.text },
    });
    if (existing) continue;

    await ideas.save(
      ideas.create({
        text: pendingIdea.text,
        status: RoadmapIdeaStatus.Pending,
        category: pendingIdea.category,
        note: pendingIdea.note,
        duplicateOfItemId: pendingIdea.duplicateOfName
          ? (nameToId.get(pendingIdea.duplicateOfName) ?? null)
          : null,
        votes: pendingIdea.votes,
        submittedById: null,
        sortOrder: nextSortOrder++,
      }),
    );
    insertedCount += 1;
  }

  for (const notBuilding of ROADMAP_ADMIN_SEED_NOT_BUILDING) {
    const existing = await ideas.findOne({
      where: { text: notBuilding.text },
    });
    if (existing) continue;

    await ideas.save(
      ideas.create({
        text: notBuilding.text,
        status: RoadmapIdeaStatus.Dismissed,
        category: notBuilding.category,
        declineReason: notBuilding.declineReason,
        declineNote: notBuilding.declineNote,
        votes: notBuilding.votes,
        submittedById: null,
        sortOrder: nextSortOrder++,
      }),
    );
    insertedCount += 1;
  }

  console.log(
    `Seeded ${insertedCount} roadmap admin ideas (pending + not-building)`,
  );
}

// `roadmap_team_members.userId` is `NOT NULL UNIQUE` (migration
// `AddRoadmapAdminModel`) — a roster row can only exist for a member whose
// account actually got seeded. A `slug` that doesn't resolve is SKIPPED
// entirely (not inserted with a null/placeholder userId, which the schema
// forbids anyway), leaving the Capacity view's roster short rather than
// failing the whole seed run.
async function seedRoadmapAdminTeam(
  manager: EntityManager,
  memberIdBySlug: Map<string, string>,
): Promise<void> {
  const team = manager.getRepository(RoadmapTeamMember);
  let insertedCount = 0;
  let skippedCount = 0;

  for (const member of ROADMAP_ADMIN_SEED_TEAM) {
    const userId = memberIdBySlug.get(member.slug);
    if (!userId) {
      skippedCount += 1;
      continue;
    }

    const existing = await team.findOne({ where: { userId } });
    if (existing) continue;

    await team.save(
      team.create({
        userId,
        role: member.role,
        weeklyCapHours: member.weeklyCapHours,
        paid: member.paid,
        sortOrder: member.sortOrder,
      }),
    );
    insertedCount += 1;
  }

  console.log(
    `Seeded ${insertedCount} roadmap team members (${skippedCount} skipped, no matching seeded user)`,
  );
}

// Idempotent per (actorLabel, action) — audit rows have no natural unique
// column, this pair is specific enough for a one-shot fixture. `createdAt`
// is a `@CreateDateColumn`, always overwritten with `new Date()` on insert,
// so each row needs the same backdating follow-up `.update()` that
// `seed.ts`'s `seedVouches`/`seedReports` use for their historical rows.
async function seedRoadmapAdminAudit(
  manager: EntityManager,
  memberIdBySlug: Map<string, string>,
): Promise<void> {
  const auditLog = manager.getRepository(RoadmapAuditLog);
  let insertedCount = 0;

  for (const entry of ROADMAP_ADMIN_SEED_AUDIT) {
    const existing = await auditLog.findOne({
      where: { actorLabel: entry.actorLabel, action: entry.action },
    });
    if (existing) continue;

    const saved = await auditLog.save(
      auditLog.create({
        actorId: entry.actorSlug
          ? (memberIdBySlug.get(entry.actorSlug) ?? null)
          : null,
        actorLabel: entry.actorLabel,
        action: entry.action,
      }),
    );
    await auditLog.update(
      { id: saved.id },
      { createdAt: new Date(entry.createdAt) },
    );
    insertedCount += 1;
  }

  console.log(`Seeded ${insertedCount} roadmap audit log entries`);
}

// Singleton upsert, same idiom as `RoadmapAdminService.updateSettings`.
async function seedRoadmapAdminHeroStats(
  manager: EntityManager,
): Promise<void> {
  const settings = manager.getRepository(RoadmapSettings);
  let row = await settings.findOne({ where: { id: 1 } });
  if (!row) {
    row = settings.create({ id: 1, heroStats: [] });
  }
  row.heroStats = ROADMAP_ADMIN_SEED_HERO_STATS;
  await settings.save(row);
  console.log('Seeded roadmap admin hero stats');
}

/**
 * Entry point wired into `src/database/seed.ts` (`pnpm run seed`) — see the
 * file-level doc comment for why this is a seed-runner pass rather than
 * migration DML. `memberIdBySlug` is the same slug->userId map
 * `seed()` builds and threads through every other domain's seed function;
 * Task A8 added `tiago-costa`/`mariana-reis`/`jo-silva`/`ana-duarte`/
 * `vera-lopes` to `MEMBERS` there so this map can resolve them.
 */
export async function seedRoadmapAdminContent(
  manager: EntityManager,
  memberIdBySlug: Map<string, string>,
): Promise<void> {
  const nameToId = await seedRoadmapAdminItems(manager, memberIdBySlug);
  await seedRoadmapAdminDependencies(manager, nameToId);
  await seedRoadmapAdminIdeas(manager, nameToId);
  await seedRoadmapAdminTeam(manager, memberIdBySlug);
  await seedRoadmapAdminAudit(manager, memberIdBySlug);
  await seedRoadmapAdminHeroStats(manager);
}
