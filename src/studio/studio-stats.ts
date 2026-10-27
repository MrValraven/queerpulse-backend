import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioReleaseHealthItem } from './studio-release-health';
import { StudioReleaseCard, StudioTrackSummary } from './studio-response';
import { STUDIO_STATS_THRESHOLD } from './studio.constants';

/** Studio dashboard: the follower chart covers this many weeks, the current
 *  partial week included. */
export const STUDIO_FOLLOWER_GROWTH_WEEKS = 12;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** A count on the stats page. 1 to 4 are withheld (`value: null`), so a
 *  small number never points at a handful of identifiable members. Zero
 *  stays zero. */
export interface StudioCount {
  value: number | null;
  isBelowThreshold: boolean;
}

export interface StudioTrackStatsRow {
  track: StudioTrackSummary;
  saves: StudioCount;
  playlistInclusions: StudioCount;
  /** Studio dashboard listening: all-time plays from the daily totals. */
  plays: StudioCount;
  /** Plays in the 28 UTC days ending today. */
  plays28d: StudioCount;
}

export interface StudioReleaseStatsRow {
  release: StudioReleaseCard & { status: StudioReleaseStatus };
  saves: StudioCount;
  /** Distinct public playlists holding any of the release's tracks. */
  playlistInclusions: StudioCount;
  /** Studio v3: Notify me reminders on a scheduled release, under the same
   *  floor; null for every other status. */
  reminders: StudioCount | null;
  /** Studio dashboard listening: the release's track plays summed (withheld
   *  tracks included), then floored once; zero for a show. */
  plays: StudioCount;
  /** The same sum over the 28 UTC days ending today. */
  plays28d: StudioCount;
  tracks: StudioTrackStatsRow[];
  /** Studio dashboard: the release checklist; empty for a taken-down one. */
  health: StudioReleaseHealthItem[];
}

/** New followers in one UTC week that starts on a Monday. The count is shown
 *  as is, like the follower total. */
export interface StudioFollowerGrowthWeek {
  weekStart: string;
  newFollowers: number;
}

/** The scheduled release that goes out first, with its Notify me reminders
 *  under the same floor as the release row. */
export interface StudioNextRelease {
  releaseId: string;
  title: string;
  publishAt: string;
  reminders: StudioCount;
}

export interface StudioArtistStats {
  subprofileId: string;
  /** Shown as is: already public on the persona page. */
  followerCount: number;
  /** Oldest week first, the current partial week last. */
  followerGrowth: StudioFollowerGrowthWeek[];
  nextRelease: StudioNextRelease | null;
  releases: StudioReleaseStatsRow[];
}

/** The Monday starts (`YYYY-MM-DD`, UTC) of the follower chart's weeks,
 *  oldest first; the last one is the Monday of `now`'s week. */
export function followerGrowthWeekStarts(now: Date): string[] {
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  const currentMonday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - daysSinceMonday,
  );
  const weekStarts: string[] = [];
  for (
    let weeksBack = STUDIO_FOLLOWER_GROWTH_WEEKS - 1;
    weeksBack >= 0;
    weeksBack -= 1
  ) {
    weekStarts.push(
      new Date(currentMonday - weeksBack * 7 * MILLISECONDS_PER_DAY)
        .toISOString()
        .slice(0, 10),
    );
  }
  return weekStarts;
}

/** One entry per week start, zero for a week with no row. A row outside
 *  the window is left out. */
export function toFollowerGrowth(
  weekStarts: string[],
  rows: { week_start: string; new_followers: number | string }[],
): StudioFollowerGrowthWeek[] {
  const countsByWeekStart = new Map(
    rows.map((row) => [row.week_start, Number(row.new_followers)]),
  );
  return weekStarts.map((weekStart) => ({
    weekStart,
    newFollowers: countsByWeekStart.get(weekStart) ?? 0,
  }));
}

/** The scheduled release with the earliest `publishAt`, ties by id
 *  ascending; null when nothing is scheduled. */
export function toNextRelease(
  releases: StudioRelease[],
  reminderCounts: Map<string, number>,
): StudioNextRelease | null {
  const [soonest] = releases
    .flatMap((release) =>
      release.status === StudioReleaseStatus.Scheduled && release.publishAt
        ? [{ release, publishAt: release.publishAt }]
        : [],
    )
    .sort(
      (left, right) =>
        left.publishAt.getTime() - right.publishAt.getTime() ||
        left.release.id.localeCompare(right.release.id),
    );
  if (!soonest) {
    return null;
  }
  return {
    releaseId: soonest.release.id,
    title: soonest.release.title,
    publishAt: soonest.publishAt.toISOString(),
    reminders: toStudioCount(reminderCounts.get(soonest.release.id) ?? 0),
  };
}

export function toStudioCount(count: number): StudioCount {
  if (count > 0 && count < STUDIO_STATS_THRESHOLD) {
    return { value: null, isBelowThreshold: true };
  }
  return { value: count, isBelowThreshold: false };
}

/** Studio dashboard listening: the play trend covers this many UTC days,
 *  today (partial) included. */
export const STUDIO_PLAY_WINDOW_DAYS = 28;

/** The days (`YYYY-MM-DD`, UTC) of the play window, oldest first; the last
 *  one is `now`'s own UTC day. */
export function playWindowDays(now: Date): string[] {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const days: string[] = [];
  for (
    let daysBack = STUDIO_PLAY_WINDOW_DAYS - 1;
    daysBack >= 0;
    daysBack -= 1
  ) {
    days.push(
      new Date(today - daysBack * MILLISECONDS_PER_DAY)
        .toISOString()
        .slice(0, 10),
    );
  }
  return days;
}

export interface StudioArtistPlayDay {
  day: string;
  plays: StudioCount;
}

/** `GET /studio/artists/:subprofileId/plays`: own and credited tracks, every
 *  value under the stats floor. */
export interface StudioArtistPlays {
  /** One entry per window day, oldest first, each day floored on its own. */
  days: StudioArtistPlayDay[];
  /** All time. */
  total: StudioCount;
  /** The window summed, then floored once. */
  total28d: StudioCount;
}

/** One entry per window day, zero for a day with no row; a row outside the
 *  window is left out. The window total sums the raw day counts and is
 *  floored once. */
export function toArtistPlays(
  windowDays: string[],
  rows: { day: string; plays: number | string }[],
  total: number,
): StudioArtistPlays {
  const playsByDay = new Map(rows.map((row) => [row.day, Number(row.plays)]));
  const dayCounts = windowDays.map((day) => ({
    day,
    count: playsByDay.get(day) ?? 0,
  }));
  return {
    days: dayCounts.map((entry) => ({
      day: entry.day,
      plays: toStudioCount(entry.count),
    })),
    total: toStudioCount(total),
    total28d: toStudioCount(
      dayCounts.reduce((sum, entry) => sum + entry.count, 0),
    ),
  };
}

/** Published releases by `published_at desc, id desc`, then drafts,
 *  scheduled and taken-down releases by `updated_at desc, id desc`. */
export function orderReleasesForStats(
  releases: StudioRelease[],
): StudioRelease[] {
  const byIdDescending = (left: StudioRelease, right: StudioRelease): number =>
    right.id.localeCompare(left.id);
  const published = releases
    .filter((release) => release.status === StudioReleaseStatus.Published)
    .sort(
      (left, right) =>
        (right.publishedAt?.getTime() ?? 0) -
          (left.publishedAt?.getTime() ?? 0) || byIdDescending(left, right),
    );
  const others = releases
    .filter((release) => release.status !== StudioReleaseStatus.Published)
    .sort(
      (left, right) =>
        right.updatedAt.getTime() - left.updatedAt.getTime() ||
        byIdDescending(left, right),
    );
  return [...published, ...others];
}
