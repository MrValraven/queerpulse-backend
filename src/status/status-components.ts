import {
  DATABASE_PROBE_KEY,
  type PlatformProbeKey,
} from '../health/platform-probes.service';

/**
 * The public status page's vocabulary. Deliberately tiny: a component is
 * `operational`, `degraded` or `down`, and nothing more. No latency, no error
 * text, no host, no build. A member locked out of the platform needs exactly
 * one thing from this page — "is it me or is it them?" — and every extra field
 * is either noise or a leak.
 */
export const STATUS_STATES = ['operational', 'degraded', 'down'] as const;
export type StatusState = (typeof STATUS_STATES)[number];

/** Worst-wins ordering, used to fold many states into one. */
const STATE_RANK: Record<StatusState, number> = {
  operational: 0,
  degraded: 1,
  down: 2,
};

export function worstState(states: StatusState[]): StatusState {
  return states.reduce<StatusState>(
    (worst, state) => (STATE_RANK[state] > STATE_RANK[worst] ? state : worst),
    'operational',
  );
}

/**
 * The member-facing areas the status page lists. These are STABLE IDS, never
 * display text: the frontend translates each one through
 * `system:status.live.component.*`, so renaming a component here would be a
 * breaking change to that catalog and to any bookmarked incident.
 *
 * `dependsOn` is what makes the derived half of this page honest. Every area
 * below is a Postgres-backed read/write path, so when the database probe is
 * unreachable all of them genuinely are: the page says so rather than showing
 * a comforting green list served by an app instance that can answer nothing.
 */
export const STATUS_COMPONENT_IDS = [
  'accounts',
  'messaging',
  'communities',
  'directory',
  'magazine',
  'media',
] as const;

export type StatusComponentId = (typeof STATUS_COMPONENT_IDS)[number];

export const STATUS_COMPONENT_DEPENDENCIES: Record<
  StatusComponentId,
  PlatformProbeKey[]
> = {
  accounts: [DATABASE_PROBE_KEY],
  messaging: [DATABASE_PROBE_KEY],
  communities: [DATABASE_PROBE_KEY],
  directory: [DATABASE_PROBE_KEY],
  magazine: [DATABASE_PROBE_KEY],
  media: [DATABASE_PROBE_KEY],
};

export function isStatusComponentId(value: string): value is StatusComponentId {
  return (STATUS_COMPONENT_IDS as readonly string[]).includes(value);
}
