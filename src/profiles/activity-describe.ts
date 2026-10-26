import {
  Activity,
  ActivityKind,
  ActivitySubjectKind,
} from './entities/activity.entity';

/**
 * The structured reading of an activity row, so the profile "Recent activity"
 * section can render its own verb and subject (and translate them) instead of
 * showing the stored English sentence.
 */
export type ActivityAction =
  'rsvp' | 'thread' | 'communityPost' | 'join' | 'persona';

// The fixed English prefixes `ActivityListener` writes its titles with. The
// listener builds every title from these same constants, so the parser below
// and the writer can never drift apart. Changing one changes how OLD rows
// parse too, so a reworded prefix leaves earlier rows on the `title` fallback.
export const RSVP_TITLE_PREFIX = "RSVP'd to ";
export const THREAD_TITLE_PREFIX = 'Started a thread: ';
export const COMMUNITY_POST_TITLE_PREFIX = 'Posted in ';
export const JOIN_TITLE_PREFIX = 'Joined ';
export const PERSONA_TITLE_PREFIX = 'Published a persona: ';

export interface ActivityDescription {
  action: ActivityAction | null;
  subject: string | null;
}

const UNDESCRIBED: ActivityDescription = { action: null, subject: null };

/** Which prefix (and so which action) a row of this kind is written with. */
function prefixFor(
  row: Pick<Activity, 'kind' | 'subjectKind'>,
): { action: ActivityAction; prefix: string } | null {
  switch (row.kind) {
    case ActivityKind.Event:
      return { action: 'rsvp', prefix: RSVP_TITLE_PREFIX };
    case ActivityKind.Community:
      return { action: 'join', prefix: JOIN_TITLE_PREFIX };
    case ActivityKind.Persona:
      return { action: 'persona', prefix: PERSONA_TITLE_PREFIX };
    case ActivityKind.Post:
      // The two post variants share a kind and differ by what they are about.
      if (row.subjectKind === ActivitySubjectKind.ForumThread) {
        return { action: 'thread', prefix: THREAD_TITLE_PREFIX };
      }
      if (row.subjectKind === ActivitySubjectKind.Community) {
        return { action: 'communityPost', prefix: COMMUNITY_POST_TITLE_PREFIX };
      }
      return null;
    default:
      return null;
  }
}

/**
 * Split a stored title into its action and subject ("RSVP'd to Poetry Night"
 * reads as `rsvp` + "Poetry Night"). A row only gets an action when BOTH its
 * kind and its exact title prefix match what the listener writes; anything
 * else (a legacy row, a reworded title, an empty subject) comes back with both
 * fields null so the frontend falls back to showing `title` as written.
 */
export function describeActivity(
  row: Pick<Activity, 'kind' | 'subjectKind' | 'title'>,
): ActivityDescription {
  const match = prefixFor(row);
  if (!match || !row.title.startsWith(match.prefix)) {
    return UNDESCRIBED;
  }
  const subject = row.title.slice(match.prefix.length).trim();
  if (!subject) {
    return UNDESCRIBED;
  }
  return { action: match.action, subject };
}

// Kinds that state a lasting fact about ONE subject (attending this event,
// being in this community, having published this persona), so only the newest
// row per subject is worth showing. Posts stay out: each post is its own fact.
export const DEDUPED_ACTIVITY_KINDS: ReadonlySet<ActivityKind> = new Set([
  ActivityKind.Persona,
  ActivityKind.Event,
  ActivityKind.Community,
]);

/** Whether a row with this kind and subject is collapsed to its newest copy. */
export function isDedupedActivity(
  row: Pick<Activity, 'kind' | 'subjectId'>,
): boolean {
  return DEDUPED_ACTIVITY_KINDS.has(row.kind) && row.subjectId !== null;
}

/**
 * Collapse repeat rows about one subject (a persona re-published, an event
 * re-RSVP'd) to the newest one. Rows arrive newest first, so the first row
 * seen per (kind, subjectKind, subjectId) is kept and later copies dropped.
 * Order is preserved. This is the read-side half of the fix: rows stacked
 * before `ActivityService.record` started replacing them collapse here with no
 * migration.
 */
export function dedupeActivity(rows: Activity[]): Activity[] {
  const seenSubjects = new Set<string>();
  return rows.filter((row) => {
    if (!isDedupedActivity(row)) {
      return true;
    }
    const subjectKey = `${row.kind}|${row.subjectKind ?? ''}|${row.subjectId}`;
    if (seenSubjects.has(subjectKey)) {
      return false;
    }
    seenSubjects.add(subjectKey);
    return true;
  });
}
