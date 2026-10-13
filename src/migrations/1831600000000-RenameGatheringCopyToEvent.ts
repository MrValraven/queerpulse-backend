// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Copy rename: the hosted thing is called an "event" (EN) / "evento" (PT)
 * everywhere a reader can see it, no longer "gathering" / "encontro".
 *
 * `BackfillResourceGuides1794833210000` inserted the guide prose below and
 * `ON CONFLICT DO NOTHING` means editing that file changes nothing for any
 * database that already ran it. So this rewrites the live rows, one EXACT
 * known phrase at a time, scoped to the guide's slug. A row an editor has
 * reworded no longer contains the phrase and is left alone, and no other
 * text in a row is touched.
 *
 * `title_pt`, `description_pt` and `body` are text. `sections` and
 * `sections_pt` are jsonb, so they are rewritten through their text cast and
 * cast back; every phrase is plain prose with no characters JSON escapes.
 * Reversible: `down()` swaps each phrase back. Re-run-safe in both directions.
 *
 * The same treatment covers the seeded roadmap items, roadmap ideas and the
 * welcome email template (scoped by their old or new name, text or label, since
 * those tables have no slug). A scope accepts both the old and the new value of
 * the scoping column, so the order of entries never matters and `down()` finds
 * the same rows. `category` is a whole-value match.
 *
 * Not touched on purpose: `AddGovernanceMemberMotions1794780000000` (its
 * `gathering` is an enum label and a column name, not copy) and
 * `RemoveSeededGovernanceFinances1828700000000` (its strings sit in `down()`
 * only, to restore rows that `up()` deleted).
 */

type RewriteTable =
  'resources' | 'roadmap_items' | 'roadmap_ideas' | 'email_templates';
type ScopeColumn = 'slug' | 'name' | 'text' | 'label';
type RewriteColumn =
  | 'title_pt'
  | 'description_pt'
  | 'body'
  | 'sections'
  | 'sections_pt'
  | 'name'
  | 'text'
  | 'category'
  | 'description'
  | 'locales';

interface PhraseRewrite {
  table: RewriteTable;
  /** Column that picks the seeded row(s). */
  scopeColumn: ScopeColumn;
  /** Accepted values of `scopeColumn` (old and new, when the rewrite changes it). */
  scope: string[];
  column: RewriteColumn;
  from: string;
  to: string;
  /** Match the whole column value instead of a phrase inside it. */
  isWholeValue?: boolean;
}

const JSON_COLUMNS: ReadonlySet<RewriteColumn> = new Set<RewriteColumn>([
  'sections',
  'sections_pt',
  'locales',
]);

const GUIDE_REWRITES: PhraseRewrite[] = [
  // first-meetup-guide
  {
    table: 'resources',
    scopeColumn: 'slug',
    scope: ['first-meetup-guide'],
    column: 'title_pt',
    from: 'O teu primeiro encontro QueerPulse',
    to: 'O teu primeiro evento QueerPulse',
  },
  {
    table: 'resources',
    scopeColumn: 'slug',
    scope: ['first-meetup-guide'],
    column: 'description_pt',
    from: 'num primeiro encontro presencial',
    to: 'num primeiro evento presencial',
  },
  {
    table: 'resources',
    scopeColumn: 'slug',
    scope: ['first-meetup-guide'],
    column: 'body',
    from: "Check the gathering's pinned post.",
    to: "Check the event's pinned post.",
  },
  {
    table: 'resources',
    scopeColumn: 'slug',
    scope: ['first-meetup-guide'],
    column: 'sections',
    from: "Check the gathering's pinned post.",
    to: "Check the event's pinned post.",
  },
  {
    table: 'resources',
    scopeColumn: 'slug',
    scope: ['first-meetup-guide'],
    column: 'sections_pt',
    from: 'no primeiro encontro delas.',
    to: 'no primeiro evento delas.',
  },
  {
    table: 'resources',
    scopeColumn: 'slug',
    scope: ['first-meetup-guide'],
    column: 'sections_pt',
    from: 'Vê a publicação fixada do encontro.',
    to: 'Vê a publicação fixada do evento.',
  },
  {
    table: 'resources',
    scopeColumn: 'slug',
    scope: ['first-meetup-guide'],
    column: 'sections_pt',
    from: 'O próximo encontro está no quadro.',
    to: 'O próximo evento está no quadro.',
  },
  // running-guide
  {
    table: 'resources',
    scopeColumn: 'slug',
    scope: ['running-guide'],
    column: 'body',
    from: 'Find the next run on the gatherings board.',
    to: 'Find the next run on the events board.',
  },
  {
    table: 'resources',
    scopeColumn: 'slug',
    scope: ['running-guide'],
    column: 'sections',
    from: 'Find the next run on the gatherings board.',
    to: 'Find the next run on the events board.',
  },
  {
    table: 'resources',
    scopeColumn: 'slug',
    scope: ['running-guide'],
    column: 'sections_pt',
    from: 'no quadro de encontros.',
    to: 'no quadro de eventos.',
  },
  // spoon-theory
  {
    table: 'resources',
    scopeColumn: 'slug',
    scope: ['spoon-theory'],
    column: 'body',
    from: 'Every gathering has an online option',
    to: 'Every event has an online option',
  },
  {
    table: 'resources',
    scopeColumn: 'slug',
    scope: ['spoon-theory'],
    column: 'body',
    from: 'Every gathering is hybrid, drop-in',
    to: 'Every event is hybrid, drop-in',
  },
  {
    table: 'resources',
    scopeColumn: 'slug',
    scope: ['spoon-theory'],
    column: 'sections',
    from: 'Every gathering has an online option',
    to: 'Every event has an online option',
  },
  {
    table: 'resources',
    scopeColumn: 'slug',
    scope: ['spoon-theory'],
    column: 'sections',
    from: 'Every gathering is hybrid, drop-in',
    to: 'Every event is hybrid, drop-in',
  },
  {
    table: 'resources',
    scopeColumn: 'slug',
    scope: ['spoon-theory'],
    column: 'sections_pt',
    from: 'Todos os encontros têm opção online',
    to: 'Todos os eventos têm opção online',
  },
  {
    table: 'resources',
    scopeColumn: 'slug',
    scope: ['spoon-theory'],
    column: 'sections_pt',
    from: 'Todos os encontros são híbridos',
    to: 'Todos os eventos são híbridos',
  },
];

const ROADMAP_ITEM_REWRITES: PhraseRewrite[] = [
  {
    table: 'roadmap_items',
    scopeColumn: 'name',
    scope: ['Gathering dashboard', 'Event dashboard'],
    column: 'name',
    from: 'Gathering dashboard',
    to: 'Event dashboard',
    isWholeValue: true,
  },
  {
    table: 'roadmap_items',
    scopeColumn: 'name',
    scope: ['Map view for gatherings', 'Map view for events'],
    column: 'name',
    from: 'Map view for gatherings',
    to: 'Map view for events',
    isWholeValue: true,
  },
  ...(<Array<[string, string]>>[
    ['Gathering dashboard', 'Event dashboard'],
    ['Map view for gatherings', 'Map view for events'],
    ['RSVP ticket', 'RSVP ticket'],
  ]).map(([oldName, newName]): PhraseRewrite => ({
    table: 'roadmap_items',
    scopeColumn: 'name',
    scope: [oldName, newName],
    column: 'category',
    from: 'Gatherings',
    to: 'Events',
    isWholeValue: true,
  })),
  {
    table: 'roadmap_items',
    scopeColumn: 'name',
    scope: ['Mobile app beta'],
    column: 'description',
    from: 'starting with gatherings and messaging',
    to: 'starting with events and messaging',
  },
  {
    table: 'roadmap_items',
    scopeColumn: 'name',
    scope: ['Group messaging'],
    column: 'description',
    from: 'for planning gatherings, projects',
    to: 'for planning events, projects',
  },
];

const ROADMAP_IDEA_REWRITES: PhraseRewrite[] = [
  ...(<Array<[string, string]>>[
    [
      'Recurring gatherings (monthly series)',
      'Recurring events (monthly series)',
    ],
    ['Buddy system for first gatherings', 'Buddy system for first events'],
    ['Sober-friendly gathering tag', 'Sober-friendly event tag'],
  ]).map(([oldText, newText]): PhraseRewrite => ({
    table: 'roadmap_ideas',
    scopeColumn: 'text',
    scope: [oldText, newText],
    column: 'text',
    from: oldText,
    to: newText,
    isWholeValue: true,
  })),
  ...(<Array<[string, string]>>[
    ['Buddy system for first gatherings', 'Buddy system for first events'],
    ['Sober-friendly gathering tag', 'Sober-friendly event tag'],
  ]).map(([oldText, newText]): PhraseRewrite => ({
    table: 'roadmap_ideas',
    scopeColumn: 'text',
    scope: [oldText, newText],
    column: 'category',
    from: 'Gatherings',
    to: 'Events',
    isWholeValue: true,
  })),
];

const EMAIL_TEMPLATE_REWRITES: PhraseRewrite[] = [
  {
    table: 'email_templates',
    scopeColumn: 'label',
    scope: ['Welcome: invite approved'],
    column: 'locales',
    from: 'Gatherings near you',
    to: 'Events near you',
  },
  {
    table: 'email_templates',
    scopeColumn: 'label',
    scope: ['Welcome: invite approved'],
    column: 'locales',
    from: 'Encontros perto de ti',
    to: 'Eventos perto de ti',
  },
];

const REWRITES: PhraseRewrite[] = [
  ...GUIDE_REWRITES,
  ...ROADMAP_ITEM_REWRITES,
  ...ROADMAP_IDEA_REWRITES,
  ...EMAIL_TEMPLATE_REWRITES,
];

async function applyRewrite(
  queryRunner: QueryRunner,
  rewrite: PhraseRewrite,
  from: string,
  to: string,
): Promise<void> {
  const { table, scopeColumn, scope, column, isWholeValue } = rewrite;
  // Table and column names come from the closed unions above, never from input.
  const isJson = JSON_COLUMNS.has(column);
  const current = isJson ? `"${column}"::text` : `"${column}"`;
  const assignment = isJson
    ? `"${column}" = replace(${current}, $1, $2)::jsonb`
    : isWholeValue
      ? `"${column}" = $2`
      : `"${column}" = replace(${current}, $1, $2)`;
  const guard = isWholeValue
    ? `${current} = $1`
    : `position($1 in ${current}) > 0`;
  await queryRunner.query(
    `UPDATE "${table}" SET ${assignment} WHERE "${scopeColumn}" = ANY($3) AND ${guard}`,
    [from, to, scope],
  );
}

export class RenameGatheringCopyToEvent1831600000000 implements MigrationInterface {
  name = 'RenameGatheringCopyToEvent1831600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const rewrite of REWRITES) {
      await applyRewrite(queryRunner, rewrite, rewrite.from, rewrite.to);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const rewrite of REWRITES) {
      await applyRewrite(queryRunner, rewrite, rewrite.to, rewrite.from);
    }
  }
}
