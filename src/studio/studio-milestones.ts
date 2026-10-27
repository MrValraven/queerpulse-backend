import type { StudioArtistRef } from './studio-response';

export const STUDIO_MILESTONE_KINDS = [
  'followers',
  'first_placement',
  'track_plays',
  'artist_plays',
] as const;
export type StudioMilestoneKind = (typeof STUDIO_MILESTONE_KINDS)[number];

/** Follower counts that earn a milestone before the regular steps start. */
export const STUDIO_FOLLOWER_MILESTONE_THRESHOLDS = [
  10, 25, 50, 100, 250, 500, 1000,
] as const;
/** Past the fixed list, a follower milestone lands at every multiple of this. */
export const STUDIO_FOLLOWER_MILESTONE_STEP = 1000;
/** The first placement milestone records the first playlist that lists the persona. */
export const STUDIO_FIRST_PLACEMENT_THRESHOLD = 1;
/** The milestones list returns this many rows at most. */
export const STUDIO_MILESTONES_SHOWN = 50;
/** Play counts of one track that earn a milestone before the regular steps start. */
export const STUDIO_TRACK_PLAY_MILESTONE_THRESHOLDS = [
  100, 500, 1000, 5000, 10000,
] as const;
/** Past the fixed list, a track play milestone lands at every multiple of this. */
export const STUDIO_TRACK_PLAY_MILESTONE_STEP = 10000;
/** Play counts across one artist that earn a milestone. */
export const STUDIO_ARTIST_PLAY_MILESTONE_THRESHOLDS = [
  1000, 10000, 100000,
] as const;

/** Every follower threshold at or below the count, ascending. */
export function followerMilestoneThresholdsUpTo(
  followerCount: number,
): number[] {
  const reached: number[] = STUDIO_FOLLOWER_MILESTONE_THRESHOLDS.filter(
    (threshold) => threshold <= followerCount,
  );
  for (
    let threshold = STUDIO_FOLLOWER_MILESTONE_STEP * 2;
    threshold <= followerCount;
    threshold += STUDIO_FOLLOWER_MILESTONE_STEP
  ) {
    reached.push(threshold);
  }
  return reached;
}

/** Every play threshold of one track at or below the count, ascending. */
export function trackPlayMilestoneThresholdsUpTo(playCount: number): number[] {
  const reached: number[] = STUDIO_TRACK_PLAY_MILESTONE_THRESHOLDS.filter(
    (threshold) => threshold <= playCount,
  );
  for (
    let threshold = STUDIO_TRACK_PLAY_MILESTONE_STEP * 2;
    threshold <= playCount;
    threshold += STUDIO_TRACK_PLAY_MILESTONE_STEP
  ) {
    reached.push(threshold);
  }
  return reached;
}

/** Every play threshold across one artist at or below the count, ascending. */
export function artistPlayMilestoneThresholdsUpTo(playCount: number): number[] {
  return STUDIO_ARTIST_PLAY_MILESTONE_THRESHOLDS.filter(
    (threshold) => threshold <= playCount,
  );
}

export interface StudioMilestone {
  id: string;
  kind: StudioMilestoneKind;
  threshold: number;
  track: { id: string; title: string } | null;
  reachedAt: string;
}

export interface StudioMilestonesResponse {
  items: StudioMilestone[];
}

export interface StudioMilestoneCardResponse {
  milestone: StudioMilestone;
  artist: StudioArtistRef;
}

export interface StudioMilestoneRow {
  id: string;
  subprofile_id: string;
  kind: StudioMilestoneKind;
  threshold: number | string;
  reached_at: Date;
  track_id: string | null;
  track_title: string | null;
}

/** Maps a row to the wire shape. No persona or member id leaves here. */
export function toStudioMilestone(row: StudioMilestoneRow): StudioMilestone {
  const hasTrack =
    row.kind === 'track_plays' &&
    row.track_id !== null &&
    row.track_title !== null;
  return {
    id: row.id,
    kind: row.kind,
    threshold: Number(row.threshold),
    track: hasTrack
      ? { id: row.track_id as string, title: row.track_title as string }
      : null,
    reachedAt: row.reached_at.toISOString(),
  };
}

/** The select head of a milestone read; callers append their own WHERE. */
export const STUDIO_MILESTONE_SELECT_SQL = `
  SELECT
    "milestone"."id" AS "id",
    "milestone"."subprofile_id" AS "subprofile_id",
    "milestone"."kind"::text AS "kind",
    "milestone"."threshold" AS "threshold",
    "milestone"."reached_at" AS "reached_at",
    "milestone"."track_id" AS "track_id",
    "track"."title" AS "track_title"
  FROM "studio_artist_milestones" "milestone"
  LEFT JOIN "studio_tracks" "track" ON "track"."id" = "milestone"."track_id"
`;
