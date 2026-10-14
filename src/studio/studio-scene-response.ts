import { toImageUrl } from '../common/image-url';
import { StudioScene } from './entities/studio-scene.entity';
import { StudioArtistRef } from './studio-response';

export interface StudioSceneCard {
  id: string;
  slug: string;
  name: string;
  city: string;
  coverUrl: string | null;
}

/** An upcoming event on a scene page. Field names follow `EventSummary`;
 *  the frontend links `gatheringPath(slug)`. */
export interface StudioSceneEvent {
  slug: string;
  title: string;
  startAt: string;
  endAt: string | null;
  timezone: string;
  venue: string | null;
  neighbourhood: string | null;
  isOnline: boolean;
  coverImageUrl: string | null;
}

/** The contract's `StudioScene` (the entity holds that name here). */
export interface StudioSceneResponse extends StudioSceneCard {
  blurb: string | null;
  /** Up to 24, newest release in the scene first. */
  artists: StudioArtistRef[];
  /** Up to 6, soonest first. */
  upcomingEvents: StudioSceneEvent[];
}

export interface SceneEventRow {
  slug: string;
  title: string;
  start_at: Date;
  end_at: Date | null;
  timezone: string;
  venue: string | null;
  neighbourhood: string | null;
  is_online: boolean;
  cover_image_url: string | null;
}

export function toStudioSceneCard(
  scene: Pick<StudioScene, 'id' | 'slug' | 'name' | 'city' | 'coverKey'>,
): StudioSceneCard {
  return {
    id: scene.id,
    slug: scene.slug,
    name: scene.name,
    city: scene.city,
    coverUrl: toImageUrl(scene.coverKey),
  };
}

export function toStudioSceneEvent(row: SceneEventRow): StudioSceneEvent {
  return {
    slug: row.slug,
    title: row.title,
    startAt: row.start_at.toISOString(),
    endAt: row.end_at ? row.end_at.toISOString() : null,
    timezone: row.timezone,
    venue: row.venue,
    neighbourhood: row.neighbourhood,
    isOnline: row.is_online,
    coverImageUrl: toImageUrl(row.cover_image_url),
  };
}
