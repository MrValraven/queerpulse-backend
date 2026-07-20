import { slugify } from '../common/slug.util';
import { ContentSection } from './entities/content-page.entity';

/**
 * Fixtures derived from the frontend's demo-only `culture`, `support`,
 * `governance`, and `topics` features (mock data, no `*.api.ts`), shaped to
 * insert directly into the `content_pages` / `topics` tables added by
 * `src/migrations/1782800530000-AddContentPages.ts`.
 *
 * DO NOT RUN as-is against a live table — this file only exports data; it is
 * not wired into `src/database/seed.ts` (per the task's "seed + read-only,
 * do not run" instruction). A future integration would spread `contentPageSeeds`
 * / `topicSeeds` into `manager.getRepository(...).save(...)` calls alongside
 * the other domain fixtures in that file.
 *
 * Source mapping (each page's `body` is a plain-text flattening of the mock's
 * copy — the JSX-authored icons, gradients, avatar tints, and route links are
 * presentation-only and dropped, per the "no presentation fields persisted"
 * convention):
 * - `culture`  <- `queerpulse/src/features/culture/culture.data.tsx`
 *   (`TABS` -> one page per tab; body woven from `PICKS`, `COMMISSIONS`,
 *   `GALLERY`, and `RADIO`).
 * - `support`  <- `queerpulse/src/features/support/sustainer.data.tsx`
 *   (`HOW_STEPS`, `IMPACT_CARDS`, `FAQS` -> a how-it-works, an impact, and an
 *   FAQ page).
 * - `governance` <- `queerpulse/src/features/governance/governance.data.ts`
 *   (`GOVERNING_DOCS` blurbs + the moderation `STEPS` and `PRINCIPLES`
 *   sections named in `NAV`).
 * - `topics`   <- `queerpulse/src/features/topics/topics.data.tsx`'s `TOPICS`
 *   record (the five curated topics; `tag`, flattened `title`->`label`,
 *   flattened `sub`->`description`, `totalPosts`, `followerCount` (from the
 *   mock's "Members following" stat), `crisisCard`), plus `topicPostSeeds`
 *   below — a representative subset (not exhaustive) of each topic's
 *   `posts[]`, flattened to `topic_post` rows (see
 *   `entities/topic-post.entity.ts` for the modeling rationale and which
 *   mock fields map onto which columns). `topVoices` and the curated
 *   `resources` panel are still not seeded — no backend shape was requested
 *   for those (see `entities/topic.entity.ts`).
 */

export interface ContentPageSeed {
  section: ContentSection;
  slug: string;
  title: string;
  body: string;
  locale: string;
  publishedAt: Date;
}

export interface TopicSeed {
  tag: string;
  label: string;
  description: string;
  totalPosts: number;
  followerCount: number;
  crisisCard: boolean;
}

export interface TopicPostSeed {
  topicTag: string;
  authorName: string;
  authorInitials: string;
  authorTone: string;
  contextLabel: string | null;
  kind: string;
  category: string;
  title: string;
  body: string;
  reactionCount: number;
  reactionLabel: string;
  replyCount: number;
  replyLabel: string | null;
  tags: string[];
  href: string;
}

const PUBLISHED_AT = new Date('2026-01-01T00:00:00.000Z');
const LOCALE = 'en';

interface PageSource {
  section: ContentSection;
  title: string;
  body: string;
}

// --- culture (from culture.data.tsx: TABS + PICKS/COMMISSIONS/GALLERY/RADIO) ---
const CULTURE_PAGES: PageSource[] = [
  {
    section: ContentSection.Culture,
    title: 'Book · Film · Music Club',
    body: [
      "A rotating club that reads, watches, and listens together. This season we are discussing Giovanni's Room by James Baldwin (meets 14 Jun), screening Portrait of a Lady on Fire by Céline Sciamma (19 Jun), and holding a listening party for Kehlani's The Gag Order (22 Jun).",
      "Threads run alongside each pick — from Baldwin's Paris as escape versus prison, to how Sciamma plays with who has the power to see, to July nominations. Bring your reading, watch along, and argue kindly.",
    ].join('\n\n'),
  },
  {
    section: ContentSection.Culture,
    title: 'Commission Board',
    body: [
      'Where members put out calls for collaborators on creative projects. Photography, music, writing, design, and film — paid, credited, or revenue-shared, always community-first.',
      'Recent calls: portraits of queer elders in Mouraria (seeking a writer and photo editor); an EP about growing up queer in Setúbal (seeking a cellist and studio space); an English translation of a forgotten 1987 Portuguese novel (seeking a co-translator and sensitivity reader); and a zine on queer housing discrimination in Lisbon (seeking an illustrator and typesetter).',
    ].join('\n\n'),
  },
  {
    section: ContentSection.Culture,
    title: 'Art Showcase',
    body: [
      'A rolling gallery of work made by members. Mixed media, photography, painting, illustration, performance, digital, ceramics, and installation.',
      'Currently featuring Corpo Estranho (Inês Tavares, mixed media) alongside work from Sofia Andrade, Rafael Pinto, Marta Pereira, Paulo Mendes, Beatriz Noronha, Catarina Faria, and Tomás Beto.',
    ].join('\n\n'),
  },
  {
    section: ContentSection.Culture,
    title: 'Radio',
    body: [
      'A member-curated station that changes hands each week. This week: "A noite que ficou em Lisboa", curated by Beatriz Noronha — songs for 2am in Príncipe Real, songs that sound like staying when you thought you\'d leave.',
      "Now playing: Cais do Sodré by Surma. Up next: Tejo (Dino d'Santiago), Corre (Blaya), and Sem Chão (Mariza).",
    ].join('\n\n'),
  },
];

// --- support (from sustainer.data.tsx: HOW_STEPS, IMPACT_CARDS, FAQS) ---
const SUPPORT_PAGES: PageSource[] = [
  {
    section: ContentSection.Support,
    title: 'How supporting works',
    body: [
      'QueerPulse is built by a small team, with no investors, and stays free forever. Members who can, chip in to keep it that way.',
      'Pick an amount that feels right for you. Pay securely by card, Apple Pay, PayPal, or SEPA. Your Sustainer badge activates instantly. Change or cancel any time, no questions.',
    ].join('\n\n'),
  },
  {
    section: ContentSection.Support,
    title: 'Where your contribution goes',
    body: [
      'Moderation & safety — reviewing reports, managing appeals, and keeping the community a place people actually want to be in.',
      'Hosting & infrastructure — servers, email delivery, backups, and the small army of services that make it all reliable.',
      'The team — two part-time people and a small contractor budget. We pay fair wages. That costs money.',
      'Free access for everyone — supporting members make it possible for the platform to stay free for everyone else. Always.',
    ].join('\n\n'),
  },
  {
    section: ContentSection.Support,
    title: 'Supporter FAQ',
    body: [
      'Can I change or pause my amount later? Any time, from your account settings — change the amount, switch between monthly and yearly, pause, or cancel, all self-serve.',
      'Can I cancel? Yes, instantly, any time. No questions, no retention flow. Your Sustainer badge stays until the billing period ends.',
      "Do you offer refunds? If you change your mind within 14 days of a payment, email us and we'll refund it in full.",
      'Which payment methods work? Card, Apple Pay, PayPal, and SEPA direct debit for EU bank accounts, all processed by Stripe — we never see or store your card details.',
      "What if I can't afford it? The platform is free and always will be. Contributing is never required.",
    ].join('\n\n'),
  },
];

// --- governance (from governance.data.ts: GOVERNING_DOCS + STEPS + PRINCIPLES) ---
const GOVERNANCE_PAGES: PageSource[] = [
  {
    section: ContentSection.Governance,
    title: 'Constitution',
    body: 'The formal organising document — twelve plain-language articles setting out how QueerPulse is run, who decides what, and the rights every member holds.',
  },
  {
    section: ContentSection.Governance,
    title: 'Code of Conduct',
    body: "What we expect of each other, and what happens when it's breached. The code of care that every member agrees to on joining.",
  },
  {
    section: ContentSection.Governance,
    title: 'Annual Assembly',
    body: "The yearly members' meeting — agenda, resolutions, and minutes. Where significant decisions are debated and the year's work is reviewed in the open.",
  },
  {
    section: ContentSection.Governance,
    title: 'Transparency report',
    body: 'Moderation actions, finances, and data requests, in the open. Published quarterly so the community can hold the platform to account.',
  },
  {
    section: ContentSection.Governance,
    title: 'How moderation works',
    body: [
      'Report filed — any member can report another member, a gathering, a board post, or any content. Reports are confidential; the reported person is not told who filed the report.',
      'Review within 48 hours — the moderation team reviews the report within 48 hours. For urgent safety issues, same-day. The person who filed is updated at each stage.',
      'Decision and communication — possible outcomes: no action (with explanation), direct communication, warning, temporary suspension, or permanent removal. The reported person is informed of the outcome but not the reporter.',
      'Right to appeal — any member can appeal a moderation decision within 14 days. Appeals are reviewed by the advisory council, not the original team. The outcome is final.',
    ].join('\n\n'),
  },
  {
    section: ContentSection.Governance,
    title: 'Our principles',
    body: [
      'We will never sell member data. It is used only to run the platform — never shared, sold, or used for advertising.',
      'Visibility is always your choice. You control who can see your profile, posts, and activity. Defaults are conservative.',
      'No algorithms deciding who you see. No engagement algorithm, no member ranking. You see what you choose to see.',
      'Community has a voice in decisions. Significant changes are discussed in the Forum before implementation; proposals go to the council.',
      'Transparency is non-negotiable. Quarterly health reports, published moderation stats, and council meetings summarised publicly.',
      'Access is not conditional on ability to pay. A sliding scale for all paid gatherings. No one is excluded for financial circumstances.',
    ].join('\n\n'),
  },
];

export const contentPageSeeds: ContentPageSeed[] = [
  ...CULTURE_PAGES,
  ...SUPPORT_PAGES,
  ...GOVERNANCE_PAGES,
].map((p) => ({
  section: p.section,
  slug: slugify(p.title, 'page'),
  title: p.title,
  body: p.body,
  locale: LOCALE,
  publishedAt: PUBLISHED_AT,
}));

// --- topics (from topics.data.tsx's TOPICS record — the five curated topics) ---
export const topicSeeds: TopicSeed[] = [
  {
    tag: 'healthcare',
    label: 'healthcare',
    description:
      'Conversations, resources, recommendations, and warnings about navigating health systems as a queer person in Lisbon. Curated by Trans Hub & Wellbeing.',
    totalPosts: 347,
    followerCount: 1200,
    crisisCard: true,
  },
  {
    tag: 'trans',
    label: 'trans',
    description:
      'Everything trans and non-binary life in Lisbon touches — legal name changes, hormones, community, joy. Curated by Trans Hub.',
    totalPosts: 512,
    followerCount: 2100,
    crisisCard: true,
  },
  {
    tag: 'mentalhealth',
    label: 'mentalhealth',
    description:
      'Therapy that gets us, peer support, and the honest conversations in between. Curated by Wellbeing. You are not alone here.',
    totalPosts: 428,
    followerCount: 1600,
    crisisCard: true,
  },
  {
    tag: 'housing',
    label: 'housing',
    description:
      'Sublets, flatshares, co-ops, and mutual aid for finding somewhere safe to live as a queer person in Lisbon. Real listings, real people, no agencies.',
    totalPosts: 173,
    followerCount: 890,
    crisisCard: false,
  },
  {
    tag: 'nightlife',
    label: 'nightlife',
    description:
      "Where to dance, who's playing, and which rooms actually feel safe after dark. Party listings, venue reviews, and get-home-safe plans, by the people who go.",
    totalPosts: 289,
    followerCount: 1400,
    crisisCard: false,
  },
];

// --- topic posts (a representative subset — not all — of each topic's
// posts[] in topics.data.tsx, flattened per entities/topic-post.entity.ts) ---
export const topicPostSeeds: TopicPostSeed[] = [
  {
    topicTag: 'healthcare',
    authorName: 'Anika Kovač',
    authorInitials: 'AK',
    authorTone: 'coral',
    contextLabel: 'Trans & Non-Binary Network',
    kind: 'asking',
    category: 'thread',
    title: 'Anyone have recommendations for a queer-friendly GP in Lisbon?',
    body: "Preferably someone familiar with trans healthcare — I'm tired of having to explain myself from scratch every appointment. Mine retired in March…",
    reactionCount: 42,
    reactionLabel: 'relate',
    replyCount: 18,
    replyLabel: 'replies',
    tags: ['healthcare', 'trans', 'lisbon'],
    href: '/forum',
  },
  {
    topicTag: 'healthcare',
    authorName: 'Sara Pinheiro for QueerPulse Magazine',
    authorInitials: 'SP',
    authorTone: 'jade',
    contextLabel: '8 min read',
    kind: 'article',
    category: 'article',
    title: "Five things I learned navigating Lisbon's trans health system.",
    body: 'From the SNS to private clinics, what nobody tells you about waiting lists, referrals, and how to actually get a hormone prescription without losing a year of your life.',
    reactionCount: 284,
    reactionLabel: 'reads',
    replyCount: 26,
    replyLabel: 'bookmarks',
    tags: ['healthcare', 'trans', 'explainer'],
    href: '/magazine/article',
  },
  {
    topicTag: 'trans',
    authorName: 'Céu Marques',
    authorInitials: 'CM',
    authorTone: 'coral',
    contextLabel: 'Trans Hub',
    kind: 'asking',
    category: 'thread',
    title: 'Has anyone done the legal name change at Conservatória in 2026?',
    body: 'Trying to work out which documents actually get accepted now versus what the old guides say. Would love a step-by-step from someone who did it this year.',
    reactionCount: 51,
    reactionLabel: 'relate',
    replyCount: 33,
    replyLabel: 'replies',
    tags: ['trans', 'legal', 'lisbon'],
    href: '/forum',
  },
  {
    topicTag: 'trans',
    authorName: 'Nuno Alves',
    authorInitials: 'NA',
    authorTone: 'plum',
    contextLabel: 'Trans Hub',
    kind: 'thread',
    category: 'resource',
    title: 'The 2026 trans starter kit — one link, everything in it.',
    body: "Hormones, healthcare, legal, housing, and the people to ask. If you're newly out or newly arrived, start here. We keep it current so you don't have to dig.",
    reactionCount: 312,
    reactionLabel: 'upvotes',
    replyCount: 88,
    replyLabel: 'replies',
    tags: ['trans', 'resource', 'healthcare'],
    href: '/forum',
  },
  {
    topicTag: 'mentalhealth',
    authorName: 'Mariana Reis',
    authorInitials: 'MR',
    authorTone: 'jade',
    contextLabel: 'Clinical psychologist',
    kind: 'recommend',
    category: 'recommendation',
    title: 'Sliding-scale therapists who actually have openings this month.',
    body: 'Six queer-affirming practitioners with space right now, including two who work in English and one who does trauma-focused work with trans clients. DM for the list.',
    reactionCount: 97,
    reactionLabel: 'relate',
    replyCount: 41,
    replyLabel: 'replies',
    tags: ['mentalhealth', 'therapy', 'lisbon'],
    href: '/forum',
  },
  {
    topicTag: 'mentalhealth',
    authorName: 'Anonymous member',
    authorInitials: '?',
    authorTone: 'plum',
    contextLabel: 'posted anonymously',
    kind: 'asking',
    category: 'thread',
    title: "How do you tell a new therapist you're queer without the flinch?",
    body: "Every first session I brace for the pause. Looking for scripts, or honestly just to hear it gets easier. Replies from people who've been here especially welcome.",
    reactionCount: 73,
    reactionLabel: 'relate',
    replyCount: 56,
    replyLabel: 'replies',
    tags: ['mentalhealth', 'therapy'],
    href: '/forum',
  },
  {
    topicTag: 'housing',
    authorName: 'Carla Nunes',
    authorInitials: 'CN',
    authorTone: 'coral',
    contextLabel: null,
    kind: 'asking',
    category: 'thread',
    title:
      'Looking for a room in a queer household, June–August, Arroios area.',
    body: 'Quiet, employed, cat-friendly, allergic to landlord drama. Would love to land somewhere that already feels like home rather than start from zero.',
    reactionCount: 19,
    reactionLabel: 'relate',
    replyCount: 11,
    replyLabel: 'replies',
    tags: ['housing', 'sublet', 'arroios'],
    href: '/forum',
  },
  {
    topicTag: 'housing',
    authorName: 'Beatriz Lopes',
    authorInitials: 'BL',
    authorTone: 'plum',
    contextLabel: null,
    kind: 'recommend',
    category: 'recommendation',
    title: 'A landlord in Graça who actually put queer-friendly in writing.',
    body: 'Rare, I know. Fair rent, no weirdness about who visits, fixed the boiler in a day. Happy to pass the contact to anyone searching — just ask.',
    reactionCount: 34,
    reactionLabel: 'relate',
    replyCount: 16,
    replyLabel: 'replies',
    tags: ['housing', 'graca', 'lisbon'],
    href: '/forum',
  },
  {
    topicTag: 'nightlife',
    authorName: 'Diogo Faria',
    authorInitials: 'DF',
    authorTone: 'coral',
    contextLabel: 'Music producer',
    kind: 'event',
    category: 'event',
    title:
      'Warehouse party Friday — trans DJs only, door policy that means it.',
    body: 'Vetted crowd, trained welfare team, chill-out room upstairs. Location on RSVP. Bring your people, look after each other, dance until the trams start.',
    reactionCount: 62,
    reactionLabel: 'going',
    replyCount: 0,
    replyLabel: null,
    tags: ['nightlife', 'music', 'lisbon'],
    href: '/gathering/trans-djs-warehouse',
  },
  {
    topicTag: 'nightlife',
    authorName: 'Rita Vasquez',
    authorInitials: 'RV',
    authorTone: 'jade',
    contextLabel: null,
    kind: 'recommend',
    category: 'recommendation',
    title: 'A bar in Cais do Sodré that gets the vibe right on a Wednesday.',
    body: 'No pressure, no creeps, staff who step in when needed. Perfect for a first date or a soft night out. They keep the back room quiet enough to actually talk.',
    reactionCount: 48,
    reactionLabel: 'relate',
    replyCount: 15,
    replyLabel: 'replies',
    tags: ['nightlife', 'caisdosodre', 'lisbon'],
    href: '/forum',
  },
];
