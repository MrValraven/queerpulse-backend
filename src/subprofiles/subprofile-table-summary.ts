import type { SubprofileKind } from './subprofile-kinds';

/**
 * The directory card's slice of a Quest persona's "At the table" block.
 * `skin_data` has no server-side schema (the PATCH stores whatever object the
 * editor sends), so this is the one place its table values are trusted: only
 * known formats and vibes survive, in a fixed order, so a stray value can reach
 * neither a card nor the Refine panel. Mirrored by the frontend's
 * `questTable.data.ts` for demo mode.
 */
export type TableFormat = 'online' | 'in_person' | 'both';
export type TableVibe =
  | 'queer_led'
  | 'trans_led'
  | 'beginner_friendly'
  | 'adults_only'
  | 'neurodivergent_friendly'
  | 'accessible_venue';

export interface CardTableSummary {
  format: TableFormat | null;
  vibe: TableVibe[];
}

const TABLE_FORMATS: readonly TableFormat[] = ['online', 'in_person', 'both'];
const TABLE_VIBES: readonly TableVibe[] = [
  'queer_led',
  'trans_led',
  'beginner_friendly',
  'adults_only',
  'neurodivergent_friendly',
  'accessible_venue',
];

/** The kinds whose page is the Quest skin. Mirrors the FE `SKIN_OF` entries
 *  that map to `quest`; keep in step. */
export const QUEST_KINDS: ReadonlySet<SubprofileKind> = new Set<SubprofileKind>(
  [
    'game_master',
    'ttrpg_designer',
    'game_designer',
    'board_game_reviewer',
    'game_night_host',
    'larp_organizer',
    'miniature_painter',
    'cartographer',
    'dice_maker',
    'tournament_organizer',
    'actual_play',
    'streamer',
    'speedrunner',
    'modder',
    'cosplayer',
    'prop_maker',
    'puzzle_designer',
  ],
);

export function toCardTableSummary(
  kind: SubprofileKind,
  raw: unknown,
): CardTableSummary | undefined {
  if (!QUEST_KINDS.has(kind) || !raw || typeof raw !== 'object') {
    return undefined;
  }
  const block = raw as { format?: unknown; vibe?: unknown };
  const format = TABLE_FORMATS.find((value) => value === block.format) ?? null;
  const storedVibes = Array.isArray(block.vibe) ? block.vibe : [];
  const vibe = TABLE_VIBES.filter((value) => storedVibes.includes(value));
  if (format === null && vibe.length === 0) return undefined;
  return { format, vibe };
}
