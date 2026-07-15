import { slugify } from '../common/slug.util';

/**
 * Fixtures derived from the frontend's `queerpulse/src/features/resources/`
 * mock content, shaped to insert directly into the `resources` /
 * `glossary_terms` tables added by
 * `src/migrations/1782800520000-AddResources.ts`.
 *
 * DO NOT RUN as-is against a live table — this file only exports data; it is
 * not wired into `src/database/seed.ts` (per the task's "seed + read-only,
 * do not run" instruction). A future integration would spread
 * `resourceSeeds`/`glossaryTermSeeds` into `manager.getRepository(...).save(...)`
 * calls alongside the other domain fixtures in that file.
 *
 * Source mapping:
 * - `resourceSeeds` <- `queerpulse/src/features/resources/library.data.ts`'s
 *   `GUIDES` array (`cat`->category, `title`, `desc`->description, `meta`
 *   folded into `body`). `library.data.ts` is the FE's only resource-directory
 *   mock shaped like `title/desc/category` (a card list feeding
 *   `LibraryPage`); the ~25 other guide pages under `features/resources/`
 *   (`MentalHealthPage`, `HarmReductionPage`, `TransHealthcarePage`, …) are
 *   bespoke hand-built layouts (tabs, sections, modals) with no flat
 *   title/description/body mock of their own, so they were not synthesized
 *   into fake `Resource` rows — doing so would invent body copy that doesn't
 *   exist in the source. `body` is therefore a short derived paragraph (desc
 *   + format note), not the full guide copy; a real content migration would
 *   need editorial authoring of the long-form body.
 * - `glossaryTermSeeds` <- `queerpulse/src/features/resources/glossary.data.tsx`'s
 *   `BLOCKS` (English `def` only — flattened from JSX to plain text; the PT
 *   translation and inline cross-reference `meta` links are presentation-only
 *   and dropped, per the "no presentation fields" convention). `type` maps to
 *   `category`.
 */

export interface ResourceSeed {
  slug: string;
  category: string;
  title: string;
  description: string;
  body: string;
  meta: string | null;
  externalUrl: string | null;
  publishedAt: Date;
}

export interface GlossaryTermSeed {
  slug: string;
  term: string;
  definition: string;
  category: string | null;
}

const PUBLISHED_AT = new Date('2026-01-01T00:00:00.000Z');

interface GuideSource {
  cat: string;
  title: string;
  desc: string;
  meta: string;
}

// Verbatim from `library.data.ts`'s `GUIDES` (title/desc/cat/meta only —
// `to` is a frontend route, not part of the response contract).
const GUIDE_SOURCES: GuideSource[] = [
  {
    cat: 'legal',
    title: 'Workplace discrimination — the full guide',
    desc: "What Portugal's Labour Code protects, how to document incidents, and a template complaint letter for the ACT.",
    meta: 'Guide · 12 min · PT / EN',
  },
  {
    cat: 'legal',
    title: 'Rental discrimination & your rights',
    desc: 'A landlord refusing you on grounds of identity is acting illegally. How to gather evidence and where to report it.',
    meta: 'Guide · 9 min · PT / EN',
  },
  {
    cat: 'legal',
    title: 'Legal name & gender marker change',
    desc: "Step-by-step through Portugal's self-determination process — documents, timelines, and what changed in 2018.",
    meta: 'Guide · 15 min · PT / EN',
  },
  {
    cat: 'housing',
    title: 'Finding queer-friendly housing in Lisbon',
    desc: 'Neighbourhoods, red flags in listings, and how the QueerPulse housing board vets landlords.',
    meta: 'Guide · 11 min',
  },
  {
    cat: 'housing',
    title: 'Flatmate agreements that protect you',
    desc: 'A plain-language template for shared tenancies — chosen-family arrangements included.',
    meta: 'Template · 6 min',
  },
  {
    cat: 'health',
    title: 'Navigating the SNS as a queer patient',
    desc: 'Registering, finding affirming GPs, and what to do if a provider refuses or mistreats you.',
    meta: 'Guide · 10 min',
  },
  {
    cat: 'health',
    title: 'PrEP access in Portugal',
    desc: 'Eligibility, the clinics most welcoming in Lisbon, and how to get it at no cost through the SNS.',
    meta: 'Guide · 8 min',
  },
  {
    cat: 'health',
    title: 'Harm reduction, without judgement',
    desc: 'Practical safety for chemsex, substances, and recovery — written by and for the community.',
    meta: 'Guide · 9 min',
  },
  {
    cat: 'trans',
    title: 'Starting hormone therapy on the SNS',
    desc: 'Referral pathways, waiting lists, and a guide to the consultations — plus what private costs to expect.',
    meta: 'Guide · 14 min',
  },
  {
    cat: 'trans',
    title: 'Updating documents after transition',
    desc: 'Bank, employer, GP, landlord — the order to do things in, with letter templates for each.',
    meta: 'Checklist · 7 min',
  },
  {
    cat: 'finance',
    title: 'Micro-grants & solidarity funds',
    desc: 'What QueerPulse funds, how to apply, and how the community sliding scale works.',
    meta: 'Guide · 6 min',
  },
  {
    cat: 'finance',
    title: 'Money for freelancers & artists',
    desc: 'Invoicing basics in Portugal, recibos verdes, and the funds open to queer creatives.',
    meta: 'Guide · 10 min',
  },
];

export const resourceSeeds: ResourceSeed[] = GUIDE_SOURCES.map((g) => ({
  slug: slugify(g.title, 'guide'),
  category: g.cat,
  title: g.title,
  description: g.desc,
  body: `${g.desc} (${g.meta}.)`,
  // `Guide.meta` verbatim (format · read time · language) — the FE's card
  // footer chip. Kept as its own field so `LibraryPage`'s card footer has
  // something to render beyond the derived `body` above.
  meta: g.meta,
  externalUrl: null,
  publishedAt: PUBLISHED_AT,
}));

interface TermSource {
  name: string;
  type: string;
  def: string;
}

// English-only, JSX-flattened-to-plain-text transcription of
// `glossary.data.tsx`'s `BLOCKS` (every letter block present in the mock:
// A, B, C, D, V, W). PT translations and `meta` cross-reference links are
// dropped (presentation-only).
const TERM_SOURCES: TermSource[] = [
  {
    name: 'Aro/ace spectrum',
    type: 'Identity',
    def: 'Umbrella terms for people on the aromantic or asexual spectra — including grey-ace, demi, and aro-but-allosexual. Not the same as celibate. See also romantic orientation.',
  },
  {
    name: 'Affirming care',
    type: 'Healthcare',
    def: 'A clinical approach that treats the patient\'s stated identity as the working truth, rather than something to interrogate or override. The opposite of "gatekeeper" care. WPATH guidelines describe it; in Portugal, Lei n.º 38/2018 codifies parts of it.',
  },
  {
    name: 'Anjos',
    type: 'Lisbon',
    def: 'A central Lisbon neighbourhood that, since the late 2010s, has hosted much of the city\'s organised queer community space — including Café Beirão, Clínica do Largo, and the Trans Hub office. Not a "gayborhood" in the Castro sense. The community is woven into the existing residential fabric.',
  },
  {
    name: 'Assigned at birth',
    type: 'Essential',
    def: "As in AFAB / AMAB — the sex marker placed on a person's birth certificate. The phrasing emphasises that this was a decision made by others, often without examination. Useful in medical contexts; less needed in social ones.",
  },
  {
    name: 'Binary',
    type: 'Identity',
    def: 'Of gender systems that recognise only two categories (man / woman). The word is often a shorthand for limitations, not a description of any individual.',
  },
  {
    name: 'Bichas',
    type: 'Portuguese · in-community',
    def: 'A reclaimed Portuguese term, roughly equivalent to "queer" used as a noun, used widely within the community. Reclamation matters here. Use only if you\'re inside; otherwise, opt for queer.',
  },
  {
    name: 'Butch / Femme',
    type: 'Identity · contested',
    def: "Long-standing terms for masc and femme presentations within queer (particularly lesbian and trans-masc) communities. Identity, not costume. Discussions about who can use them are ongoing — we don't adjudicate.",
  },
  {
    name: 'Cis',
    type: 'Essential',
    def: 'Short for cisgender — describing a person whose gender matches the one they were assigned at birth. Not an insult, not a slur, just a descriptor — symmetric to "trans". Latin: cis- means "on this side of".',
  },
  {
    name: 'Chosen family',
    type: 'Essential',
    def: "The set of intentional, ongoing relationships of care that queer people build, often in parallel with (and sometimes in place of) biological family. Includes lovers, exes, friends, neighbours, and the person who calls if you don't post for three days.",
  },
  {
    name: 'Coming out',
    type: 'Essential',
    def: 'The ongoing act of disclosing a non-heterosexual or non-cisgender identity. Not a one-time event. Most queer people come out hundreds of times — to coworkers, to taxi drivers, to landlords, to GPs.',
  },
  {
    name: 'Deadname',
    type: 'Healthcare',
    def: "The name a trans person no longer uses, typically the one assigned at birth. Don't use it — even with permission, even in the past tense, even at a doctor's office. Lei n.º 38/2018 permits self-determination of name on most records in Portugal.",
  },
  {
    name: 'Drag',
    type: 'Performance',
    def: "A theatrical performance of gender. Not the same as being trans. Drag has a queer history, but plenty of straight and cis people do it; plenty of trans people don't.",
  },
  {
    name: 'Vouch',
    type: 'QueerPulse · platform',
    def: "On QueerPulse, to vouch for someone is to attach your name to theirs as a marker of community trust. Used in three places: member onboarding (you vouch for who you're inviting), safe spaces (you vouch a venue lives up to the pact), and service offers (you vouch a therapist or skill-provider is what they say). Vouches are personal — they accumulate, they don't get rated.",
  },
  {
    name: 'WPATH',
    type: 'Healthcare',
    def: 'The World Professional Association for Transgender Health. Publishes the Standards of Care, the most widely-used clinical guidelines for trans-affirming care. Currently on version 8. Used by most Lisbon clinicians who self-identify as trans-affirming.',
  },
];

export const glossaryTermSeeds: GlossaryTermSeed[] = TERM_SOURCES.map((t) => ({
  slug: slugify(t.name, 'term'),
  term: t.name,
  definition: t.def,
  category: t.type,
}));
