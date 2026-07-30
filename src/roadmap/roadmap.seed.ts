import { RoadmapColumn } from './entities/roadmap-item.entity';
import { RoadmapIdeaStatus } from './entities/roadmap-idea.entity';
import type { HeroStat } from './entities/roadmap-settings.entity';

/**
 * Fixture transcribed from the frontend's
 * `queerpulse/src/features/marketing/roadmap.data.ts` (`HERO_STATS` /
 * `SHIPPED` / `BUILDING` / `PLANNED` / `TOP_IDEAS`), so `/about/roadmap`
 * renders unchanged once wired to `GET /roadmap`. Consumed directly by
 * `src/migrations/1785002000000-CreateRoadmap.ts`, which INSERTs these rows
 * when the table is created — there is no separate `pnpm run seed` step for
 * this module, unlike `governance`/`changemakers`.
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
    description: 'Browse upcoming events on a city map. Filter by date, type, and distance.',
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
    description: 'Ask questions anonymously within communities. No names — just honest answers.',
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
