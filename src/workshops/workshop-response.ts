import { MemberRef } from '../common/member-ref';
import {
  Workshop,
  WorkshopHeroTint,
  WorkshopLocation,
  WorkshopMode,
  WorkshopNeed,
  WorkshopSession,
  WorkshopTier,
} from './entities/workshop.entity';

/**
 * One DTO for both the list and the detail route (unlike `jobs`, which splits
 * card/detail) — `WorkshopsSection`'s card and `WorkshopPage` read from the
 * same client-side `Workshop` object, so splitting would only force the page
 * to re-fetch what the catalogue already had.
 *
 * Deliberately absent, and why:
 *  - `id` — `slug` is the public identifier on every route (mirrors `jobs`).
 *  - `format` — pure i18n chrome derived from `weeks` + `spotsTotal`
 *    (`addWorkshop.build.ts` composes it with `t(...)`); the API ships the
 *    inputs instead.
 *  - `added` — the frontend's "New" badge. Every row here is member-posted, so
 *    a stored flag would be permanently `true`; `createdAt` lets the client
 *    decide what counts as new.
 */
export interface WorkshopDTO {
  slug: string;
  cat: string;
  title: string;
  titleEm: string;
  mode: WorkshopMode;
  weeks: number;
  /** Seats actually taken — a live COUNT over `workshop_rsvps`, never a stored
   *  counter (see `Workshop.spotsTotal`'s comment). */
  spotsFilled: number;
  spotsTotal: number;
  blurb: string;
  heroPlaceholder: string | null;
  heroTint: WorkshopHeroTint;
  price: number;
  currency: string;
  priceSub: string | null;
  startDate: string | null;
  cancellation: string | null;
  tiers: WorkshopTier[];
  about: string[];
  sessions: WorkshopSession[];
  needs: WorkshopNeed[];
  pastWork: string[];
  tags: string[];
  location: WorkshopLocation;
  /** The repo's standard member ref (`src/common/member-ref.ts`). Backs the
   *  frontend's `tutor` block, including its optional profile link. */
  host: MemberRef | null;
  /** Workshop-scoped descriptor for the host, e.g. "Graça studio · potter &
   *  teacher" — the frontend's `tutor.role`. */
  hostRole: string | null;
  /** Whether the viewer is the host (gates the edit/delete affordances).
   *  Mirrors `JobDetailDTO.isPoster`. */
  isHost: boolean;
  /**
   * The viewer's own standing on this workshop — `null` when they have no
   * booking (including one they cancelled). Lets the sidebar render the right
   * control on first paint instead of flashing "Reserve a spot" at somebody who
   * already has a seat. Mirrors `EventSummary.myRsvpStatus`.
   *
   * Always `null` for the host, who cannot book their own workshop.
   */
  myRsvpStatus: 'going' | 'waitlist' | null;
  createdAt: string;
}

export function toWorkshopDTO(
  workshop: Workshop,
  host: MemberRef | null,
  isHost: boolean,
  spotsFilled: number,
  myRsvpStatus: 'going' | 'waitlist' | null = null,
): WorkshopDTO {
  return {
    slug: workshop.slug,
    cat: workshop.cat,
    title: workshop.title,
    titleEm: workshop.titleEm,
    mode: workshop.mode,
    weeks: workshop.weeks,
    spotsFilled,
    spotsTotal: workshop.spotsTotal,
    blurb: workshop.blurb,
    heroPlaceholder: workshop.heroPlaceholder,
    heroTint: workshop.heroTint,
    price: workshop.price,
    currency: workshop.currency,
    priceSub: workshop.priceSub,
    startDate: workshop.startDate,
    cancellation: workshop.cancellation,
    tiers: workshop.tiers,
    about: workshop.about,
    sessions: workshop.sessions,
    needs: workshop.needs,
    pastWork: workshop.pastWork,
    tags: workshop.tags,
    location: workshop.location,
    host,
    hostRole: workshop.hostRole,
    isHost,
    myRsvpStatus,
    createdAt: workshop.createdAt.toISOString(),
  };
}
