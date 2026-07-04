import {
  CinemaTitle,
  TitleKind,
  TitleStatus,
} from './entities/cinema-title.entity';

// Positions inside the final 3% of a title count as "finished" — the next
// playback session restarts from the beginning instead of the credits.
const FINISHED_FRACTION = 0.97;

export interface MyProgressResponse {
  positionSeconds: number;
  finished: boolean;
}

export interface TitleListItem {
  id: string;
  kind: TitleKind;
  title: string;
  description: string | null;
  coverImageUrl: string | null;
  durationSeconds: number | null;
  publishedAt: Date | null;
  viewCount: number;
  myProgress: MyProgressResponse | null;
}

export interface TitleDetail extends TitleListItem {
  status?: TitleStatus;
  errorMessage?: string | null;
}

export function isFinished(
  title: Pick<CinemaTitle, 'durationSeconds'>,
  positionSeconds: number,
): boolean {
  return (
    title.durationSeconds != null &&
    positionSeconds >= title.durationSeconds * FINISHED_FRACTION
  );
}

export function toTitleListItem(
  title: CinemaTitle,
  progress: { positionSeconds: number } | null,
): TitleListItem {
  return {
    id: title.id,
    kind: title.kind,
    title: title.title,
    description: title.description,
    coverImageUrl: title.coverImageUrl,
    durationSeconds: title.durationSeconds,
    publishedAt: title.publishedAt,
    viewCount: title.viewCount,
    myProgress: progress
      ? {
          positionSeconds: progress.positionSeconds,
          finished: isFinished(title, progress.positionSeconds),
        }
      : null,
  };
}

export function toTitleDetail(
  title: CinemaTitle,
  progress: { positionSeconds: number } | null,
  includeAdminFields: boolean,
): TitleDetail {
  const base = toTitleListItem(title, progress);
  if (!includeAdminFields) {
    return base;
  }
  return { ...base, status: title.status, errorMessage: title.errorMessage };
}
