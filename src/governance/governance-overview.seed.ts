import {
  GOVERNANCE_OVERVIEW_ID,
  OverviewCouncilSeat,
  OverviewDecision,
  OverviewHealthStat,
  OverviewModerationStep,
  OverviewPrinciple,
} from './entities/governance-overview.entity';

/**
 * Fixture for the singleton `governance_overview` row (see
 * `src/migrations/*-AddGovernanceOverview.ts`), transcribed from the frontend's
 * `queerpulse/src/features/governance/governance.data.ts`
 * (`HEALTH`/`STEPS`/`COUNCIL`/`PRINCIPLES`/`DECISIONS`).
 *
 * Structure-only, per the "structure in the DB, words in i18n" model: every
 * `*Key` field is a **short** i18n key (no namespace/section prefix — the
 * frontend prepends it, e.g. ``t(`governance:council.${roleKey}`)``), so no
 * translated prose lives here and EN/PT is preserved. `n`/`trendCount`,
 * council `name`/`initials`, `icon`, and `tint` are non-translatable data.
 *
 * Wired into `src/database/seed.ts` via `seedGovernanceOverview()` — run
 * `pnpm run seed` to populate the row so `GET /governance/overview` returns it
 * instead of 404ing.
 */

// Short stat key → `governance:health.stat.<key>.label`; short trend key →
// `governance:health.trend.<trendKey>` (with `trendCount` interpolated).
const health: OverviewHealthStat[] = [
  {
    key: 'activeMembers',
    n: '247',
    up: true,
    trendKey: 'upThisQuarter',
    trendCount: 38,
  },
  { key: 'retention', n: '96%', up: false, trendKey: 'steady' },
  { key: 'reportsFiled', n: '12', up: false, trendKey: 'allResolved' },
  { key: 'membersRemoved', n: '3', up: false, trendKey: 'cocViolations' },
  {
    key: 'gatheringsHosted',
    n: '34',
    up: true,
    trendKey: 'upVsQ1',
    trendCount: 8,
  },
  { key: 'appealUpheld', n: '1', up: false, trendKey: 'ofFiled', trendCount: 2 },
];

// Short step key → `governance:steps.<key>.title` / `.text`. Order = array order.
const moderationSteps: OverviewModerationStep[] = [
  { key: 'reportFiled' },
  { key: 'review' },
  { key: 'decision' },
  { key: 'appeal' },
];

// `name`/`initials` are real member data; `roleKey` → `governance:council.<roleKey>`;
// `tint` → the frontend's `{bg,color}` avatar palette.
const council: OverviewCouncilSeat[] = [
  {
    name: 'Mariana Loução',
    initials: 'ML',
    roleKey: 'psychologistChair',
    tint: 'jade',
  },
  {
    name: 'Raquel Baptista',
    initials: 'RB',
    roleKey: 'lawyerLegalAdvisor',
    tint: 'violet',
  },
  {
    name: 'Catarina Vaz',
    initials: 'CV',
    roleKey: 'housingActivist',
    tint: 'plum',
  },
  {
    name: 'Jonas Ferreira',
    initials: 'JF',
    roleKey: 'healthcareAdvocate',
    tint: 'jade',
  },
];

// Short principle key → `governance:principles.<key>.title` / `.text`; `icon` →
// the frontend's react-icon map. Order = array order.
const principles: OverviewPrinciple[] = [
  { key: 'noSellingData', icon: 'lock' },
  { key: 'visibilityChoice', icon: 'eye' },
  { key: 'noAlgorithms', icon: 'slash' },
  { key: 'communityVoice', icon: 'message' },
  { key: 'transparency', icon: 'book' },
  { key: 'accessNotConditional', icon: 'accessible' },
];

// Short decision key → `governance:decisions.<key>.lead` / `.body`. Order = array order.
const decisions: OverviewDecision[] = [
  { key: 'slidingScale' },
  { key: 'forumLaunched' },
  { key: 'visibilityDefaults' },
  { key: 'languageToggle' },
];

export const governanceOverviewSeed = {
  id: GOVERNANCE_OVERVIEW_ID,
  health,
  moderationSteps,
  council,
  principles,
  decisions,
};
