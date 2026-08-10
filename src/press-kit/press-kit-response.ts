import { PressContact } from './entities/press-contact.entity';
import { PressCoverage } from './entities/press-coverage.entity';

// ---- Public shapes ---------------------------------------------------------
// The FE `/about/press-kit` page is built against these EXACT shapes — do not
// add, drop, or rename fields without changing the FE in lockstep.

/** A single headline fact. `value` is ALREADY formatted for display (e.g.
 *  "1,847", "2024", "42") — the FE renders it verbatim. */
export interface PressKitFactDTO {
  key: string;
  value: string;
}

export interface PressCoverageDTO {
  id: string;
  source: string;
  title: string;
  meta: string;
  /** ISO date string (`YYYY-MM-DD`). */
  publishedOn: string;
  url: string | null;
}

export interface PressContactDTO {
  id: string;
  name: string;
  role: string;
  description: string;
  languages: string;
  email: string;
  avatarUrl: string | null;
}

export interface PressKitResponseDTO {
  facts: PressKitFactDTO[];
  coverage: PressCoverageDTO[];
  contacts: PressContactDTO[];
}

// ---- Admin shapes (public shape + the ordering/visibility columns) ---------

export interface AdminPressCoverageDTO extends PressCoverageDTO {
  position: number;
  active: boolean;
}

export interface AdminPressContactDTO extends PressContactDTO {
  position: number;
  active: boolean;
}

// ---- Facts ------------------------------------------------------------------

/** en-US grouping so counts read as "1,847" rather than "1847". Kept as a
 *  single shared formatter instance — it is stateless and reusable. */
const FACT_NUMBER_FORMAT = new Intl.NumberFormat('en-US');

/** Formats a raw count for a fact `value` — thousands separated by a comma. */
export function formatCount(value: number): string {
  return FACT_NUMBER_FORMAT.format(value);
}

/** Raw, honestly-sourced inputs for the headline facts. Every numeric input
 *  is a real DB count computed by `PressKitService`; `foundedYear` is a static
 *  module constant. A `null` input is DROPPED from the response rather than
 *  fabricated — see `buildPressKitFacts`. */
export interface PressKitFactInputs {
  /** The founding-year string (e.g. "2024"), or `null` to omit the fact. */
  foundedYear: string | null;
  activeMembers: number;
  communities: number;
  gatherings: number;
  safeSpaces: number;
  magazineIssues: number;
}

/**
 * Builds the ordered facts list, formatting each count and OMITTING any fact
 * whose source value is `null` (rather than inventing a number). Order is
 * fixed: founded, activeMembers, communities, gatherings, safeSpaces,
 * magazineIssues. Numeric facts are always present (a count is always a
 * number); `founded` is the one that can drop out when its constant is unset.
 */
export function buildPressKitFacts(
  inputs: PressKitFactInputs,
): PressKitFactDTO[] {
  const candidates: { key: string; value: string | null }[] = [
    { key: 'founded', value: inputs.foundedYear },
    { key: 'activeMembers', value: formatCount(inputs.activeMembers) },
    { key: 'communities', value: formatCount(inputs.communities) },
    { key: 'gatherings', value: formatCount(inputs.gatherings) },
    { key: 'safeSpaces', value: formatCount(inputs.safeSpaces) },
    { key: 'magazineIssues', value: formatCount(inputs.magazineIssues) },
  ];
  return candidates.flatMap((candidate) =>
    candidate.value === null
      ? []
      : [{ key: candidate.key, value: candidate.value }],
  );
}

// ---- Mappers (hand-mapped — no global serializer; never spread an entity) --

export function toPressCoverageDTO(row: PressCoverage): PressCoverageDTO {
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    meta: row.meta,
    publishedOn: row.publishedOn,
    url: row.url,
  };
}

export function toAdminPressCoverageDTO(
  row: PressCoverage,
): AdminPressCoverageDTO {
  return {
    ...toPressCoverageDTO(row),
    position: row.position,
    active: row.active,
  };
}

export function toPressContactDTO(row: PressContact): PressContactDTO {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    description: row.description,
    languages: row.languages,
    email: row.email,
    avatarUrl: row.avatarUrl,
  };
}

export function toAdminPressContactDTO(
  row: PressContact,
): AdminPressContactDTO {
  return {
    ...toPressContactDTO(row),
    position: row.position,
    active: row.active,
  };
}
