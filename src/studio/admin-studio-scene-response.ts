import { toImageUrl } from '../common/image-url';
import { StudioSceneStatus } from './studio.constants';

export interface AdminStudioScene {
  id: string;
  slug: string;
  name: string;
  city: string;
  blurb: string | null;
  coverUrl: string | null;
  status: StudioSceneStatus;
  position: number;
  /** Releases with this scene, any status. */
  releaseCount: number;
  pinnedEventCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminStudioSceneEvent {
  eventId: string;
  slug: string;
  title: string;
  startAt: string;
  venue: string | null;
  neighbourhood: string | null;
  /** Pins stay after the event passes; the member read skips them. */
  isUpcoming: boolean;
  pinnedAt: string;
}

export interface AdminStudioEventOption {
  id: string;
  slug: string;
  title: string;
  startAt: string;
  venue: string | null;
  neighbourhood: string | null;
}

export interface AdminSceneRow {
  id: string;
  slug: string;
  name: string;
  city: string;
  blurb: string | null;
  cover_key: string | null;
  status: StudioSceneStatus;
  position: number;
  release_count: number;
  pinned_event_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface AdminSceneEventRow {
  event_id: string;
  slug: string;
  title: string;
  start_at: Date;
  venue: string | null;
  neighbourhood: string | null;
  is_upcoming: boolean;
  pinned_at: Date;
}

export interface AdminEventOptionRow {
  id: string;
  slug: string;
  title: string;
  start_at: Date;
  venue: string | null;
  neighbourhood: string | null;
}

export function toAdminStudioScene(row: AdminSceneRow): AdminStudioScene {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    city: row.city,
    blurb: row.blurb,
    coverUrl: toImageUrl(row.cover_key),
    status: row.status,
    position: row.position,
    releaseCount: row.release_count,
    pinnedEventCount: row.pinned_event_count,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toAdminStudioSceneEvent(
  row: AdminSceneEventRow,
): AdminStudioSceneEvent {
  return {
    eventId: row.event_id,
    slug: row.slug,
    title: row.title,
    startAt: row.start_at.toISOString(),
    venue: row.venue,
    neighbourhood: row.neighbourhood,
    isUpcoming: row.is_upcoming,
    pinnedAt: row.pinned_at.toISOString(),
  };
}

export function toAdminStudioEventOption(
  row: AdminEventOptionRow,
): AdminStudioEventOption {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    startAt: row.start_at.toISOString(),
    venue: row.venue,
    neighbourhood: row.neighbourhood,
  };
}
