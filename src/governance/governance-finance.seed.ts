import {
  FinanceEventNote,
  FinanceLine,
  FinanceStat,
} from './entities/governance-finance-report.entity';

/**
 * Fixture for the `governance_finance_report` table added by
 * `src/migrations/1782800620000-AddGovernanceFinance.ts`, transcribed
 * verbatim from the frontend's
 * `queerpulse/src/features/governance/governance.data.ts` (`FIN_STATS`,
 * `INCOME`, `EXPENSE`, `EVENTS`) — the Q2 2026 quarterly transparency
 * snapshot that `FinancesSection` renders.
 *
 * DO NOT RUN as-is against a live table — this file only exports data; it is
 * not wired into `src/database/seed.ts` (per the task's "seed, do not run"
 * instruction). A future integration would insert `governanceFinanceSeed`
 * via `manager.getRepository(GovernanceFinanceReport).save(...)` alongside
 * the other domain fixtures in that file.
 *
 * The reserve-bar prose ("Operational reserve: €4,380 of €12,450 target")
 * and the two named partner-support disclosures are hardcoded JSX in
 * `GovernanceSections.tsx`, not part of `governance.data.ts` — left as
 * static prose per the task's instructions, not synthesized into this seed.
 */

export const financeStatsSeed: FinanceStat[] = [
  {
    n: '€4,620',
    l: 'Total income this quarter',
    trend: '↑ €380 vs Q1',
    up: true,
  },
  { n: '€4,150', l: 'Total expenditure', trend: 'Within budget', up: false },
  { n: '€470', l: 'Quarterly surplus', trend: 'Added to reserve', up: false },
  {
    n: '28',
    l: 'Members on free or reduced access',
    trend: 'No questions asked',
    up: false,
  },
];

export const financeIncomeSeed: FinanceLine[] = [
  {
    label: 'Member contributions',
    amount: '€1,840',
    note: 'Sliding scale €5–€25/month. 99 of 247 members contribute. No one is required to. No one is chased.',
    width: 80,
    items: [
      {
        name: 'Pay-what-you-can tier (€5–€9/mo)',
        period: '28 members',
        amount: '€504',
      },
      {
        name: 'Standard tier (€10–€14/mo)',
        period: '38 members',
        amount: '€836',
      },
      {
        name: 'Supporter tier (€15–€25/mo)',
        period: '33 members',
        amount: '€500',
      },
    ],
    total: { label: '99 contributing members', amount: '€1,840' },
  },
  {
    label: 'Gathering ticket sales',
    amount: '€2,180',
    note: 'Net figure. QueerPulse takes 0% of ticket revenue — 100% goes to hosts. This line covers only events we organise ourselves.',
    width: 94,
    items: [
      {
        name: 'Newcomer welcome dinner (April)',
        period: '26 tickets · €8',
        amount: '€208',
      },
      {
        name: 'Community skills fair (April)',
        period: '45 tickets · €12',
        amount: '€540',
      },
      {
        name: 'Queer cinema nights × 2 (May–June)',
        period: '38 tickets · €10',
        amount: '€380',
      },
      {
        name: 'Mental health workshops × 2',
        period: '24 tickets · €6',
        amount: '€144',
      },
      {
        name: 'Summer community dinner (June)',
        period: '47 tickets · €18',
        amount: '€846',
      },
      { name: 'Miscellaneous', period: '—', amount: '€62' },
    ],
    total: { label: '6 platform-run events', amount: '€2,180' },
  },
  {
    label: 'Partner support',
    amount: '€600',
    note: 'Restricted grants from two organisations. Disclosed in full below. Neither has any influence over platform decisions.',
    width: 26,
    items: [
      {
        name: 'Fundação Calouste Gulbenkian',
        period: 'Mental Health Fund',
        amount: '€400',
      },
      { name: 'ILGA Portugal', period: 'Community events', amount: '€200' },
    ],
    total: { label: '2 partners · restricted use only', amount: '€600' },
  },
];

export const financeExpenseSeed: FinanceLine[] = [
  {
    label: 'Platform & tools',
    amount: '€520',
    note: 'Hosting, email infrastructure, storage, and development tools. No proprietary stack — we use open-source where possible.',
    width: 26,
    items: [
      {
        name: 'Domain registration (queerpulse.pt + .com)',
        period: '€3/mo',
        amount: '€9',
      },
      { name: 'Web server (Hetzner CX41)', period: '€20/mo', amount: '€60' },
      {
        name: 'Database hosting (managed PostgreSQL)',
        period: '€28/mo',
        amount: '€84',
      },
      { name: 'Email sending (Postmark)', period: '€24/mo', amount: '€72' },
      {
        name: 'File & media storage (Backblaze B2)',
        period: '€9/mo',
        amount: '€27',
      },
      {
        name: 'Video calls (Jitsi, self-hosted)',
        period: '€12/mo',
        amount: '€36',
      },
      {
        name: 'Security & monitoring (Sentry + uptime)',
        period: '€22/mo',
        amount: '€66',
      },
      {
        name: 'Development tools (GitHub Pro, CI)',
        period: '€15/mo',
        amount: '€45',
      },
      { name: 'Design & collaboration tools', period: '€14/mo', amount: '€42' },
      { name: 'Backup & disaster recovery', period: '€13/mo', amount: '€39' },
      { name: 'Miscellaneous', period: '—', amount: '€40' },
    ],
    total: { label: '11 line items', amount: '€520' },
  },
  {
    label: 'Community events',
    amount: '€1,240',
    note: 'Venue hire, equipment, and materials for platform-organised gatherings. Newcomer events, mental health sessions, and community dinners.',
    width: 60,
    items: [
      {
        name: 'Newcomer dinner — venue (Casa do Alentejo)',
        period: 'April',
        amount: '€180',
      },
      {
        name: 'Newcomer dinner — food & catering',
        period: 'April',
        amount: '€220',
      },
      {
        name: 'Trans healthcare session — equipment',
        period: 'May · venue donated',
        amount: '€40',
      },
      {
        name: 'Skills fair — venue hire (LX Factory)',
        period: 'April',
        amount: '€280',
      },
      {
        name: 'Skills fair — materials & printing',
        period: 'April',
        amount: '€60',
      },
      {
        name: 'Queer cinema nights × 2 (Cinema Ideal)',
        period: 'May–June',
        amount: '€180',
      },
      {
        name: 'Mental health peer support rooms × 4',
        period: 'Quarterly',
        amount: '€80',
      },
      {
        name: 'Archive Night room hire × 3',
        period: 'Quarterly',
        amount: '€60',
      },
      { name: 'Miscellaneous supplies', period: '—', amount: '€140' },
    ],
    total: { label: '9 line items · 7 events subsidised', amount: '€1,240' },
  },
  {
    label: 'Mental health fund',
    amount: '€740',
    note: 'Subsidised therapy sessions for members who need them. Funded in part by the Gulbenkian grant. 11 sessions this quarter.',
    width: 36,
    items: [
      {
        name: 'Individual therapy subsidies (8 members)',
        period: 'avg €46/session',
        amount: '€368',
      },
      {
        name: 'Group therapy facilitation × 3 sessions',
        period: '€90/session',
        amount: '€270',
      },
      {
        name: 'Crisis support disbursements (2 members)',
        period: '€51 each',
        amount: '€102',
      },
    ],
    total: { label: '11 sessions · 10 members supported', amount: '€740' },
  },
  {
    label: 'Micro-grants',
    amount: '€800',
    note: 'Direct financial support to members for community projects, emergency needs, and creative work. 6 grants this quarter.',
    width: 38,
    items: [
      {
        name: 'Grant #1 — Housing emergency support',
        period: '—',
        amount: '€200',
      },
      {
        name: 'Grant #2 — Creative project (documentary)',
        period: '—',
        amount: '€150',
      },
      {
        name: 'Grant #3 — Trans healthcare travel costs',
        period: '—',
        amount: '€120',
      },
      {
        name: 'Grant #4 — Community event materials',
        period: '—',
        amount: '€80',
      },
      {
        name: 'Grant #5 — Skills training course fee',
        period: '—',
        amount: '€150',
      },
      {
        name: 'Grant #6 — Emergency relocation support',
        period: '—',
        amount: '€100',
      },
    ],
    total: { label: '6 grants awarded this quarter', amount: '€800' },
  },
  {
    label: 'Magazine production',
    amount: '€380',
    note: 'Contributor honoraria, editorial costs, and design. Contributors are paid — no unpaid labour policy.',
    width: 18,
    items: [
      {
        name: 'Contributor honoraria (9 pieces)',
        period: 'avg €28/piece',
        amount: '€252',
      },
      {
        name: 'Photography & illustration (2 pieces)',
        period: '—',
        amount: '€64',
      },
      { name: 'Editorial coordination', period: '—', amount: '€40' },
      { name: 'Design & layout', period: '—', amount: '€24' },
    ],
    total: { label: 'Issue 18 · June 2026', amount: '€380' },
  },
  {
    label: 'Moderator honoraria',
    amount: '€470',
    note: 'Small quarterly payments to our three volunteer moderators. Moderation is difficult work and should not be entirely unpaid.',
    width: 22,
    items: [
      { name: 'Mariana — lead moderator', period: 'Q2 2026', amount: '€200' },
      { name: 'Rui — moderator', period: 'Q2 2026', amount: '€150' },
      {
        name: 'Ana — moderator (part-time)',
        period: 'Q2 2026',
        amount: '€120',
      },
    ],
    total: { label: '3 moderators', amount: '€470' },
  },
];

// Reshaped from the frontend's `EVENTS: [string, string][]` tuple array into
// named `{title, body}` objects for a stable JSON contract.
export const financeEventNotesSeed: FinanceEventNote[] = [
  {
    title: 'Hosts keep 100% of ticket sales.',
    body: 'QueerPulse charges no platform fee. Sell 20 tickets at €8, you receive €160.',
  },
  {
    title: 'Sliding scale is mandatory.',
    body: 'Every paid gathering must offer a reduced rate. Members request it privately, no explanation asked.',
  },
  {
    title: 'QueerPulse subsidises specific event types.',
    body: 'Newcomer, mental health, and education events can apply for a venue subsidy. We covered 7 this quarter.',
  },
  {
    title: 'No paid promotion.',
    body: 'Events are never ranked by payment. Only recency and community engagement affect visibility.',
  },
  {
    title: 'This quarter:',
    body: '34 gatherings hosted. ~€8,400 in ticket revenue — all of which went directly to hosts.',
  },
];

export const governanceFinanceReportSeed = {
  quarter: '2026-Q2',
  stats: financeStatsSeed,
  income: financeIncomeSeed,
  expense: financeExpenseSeed,
  eventNotes: financeEventNotesSeed,
  publishedAt: new Date('2026-07-01T00:00:00.000Z'),
};
