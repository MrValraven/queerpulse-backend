import { ConflictException } from '@nestjs/common';
import { handleFormatError, normalizeHandle } from '../common/handles';
import { KIND_SEARCH_TERMS } from './subprofile-kind-search';
import type { SubprofileKind } from './subprofile-kinds';

/**
 * A linked persona's default `/p/<handle>`: the CREATOR's profile slug joined
 * to the persona's per-owner slug. The frontend mirrors these two pure helpers
 * in `src/features/subprofiles/personaHandle.ts`; change both together.
 */
export const HANDLE_MAX_LENGTH = 30;
const MIN_PERSONA_PART_LENGTH = 3;
export const MAX_DERIVATION_SUFFIX = 99;

function trimHyphens(value: string): string {
  return value.replace(/^-+|-+$/g, '');
}

/**
 * `<creatorSlug>-<personaSlug>` (plus `-<suffix>` from 2 up) cut to fit the
 * 30-char handle limit. The persona part shrinks first; it keeps at least 3
 * chars, and the creator part gives way below that.
 */
export function linkedPersonaHandleCandidate(
  creatorSlug: string,
  personaSlug: string,
  suffix = 1,
): string {
  const tail = suffix > 1 ? `-${suffix}` : '';
  const budget = HANDLE_MAX_LENGTH - tail.length;
  const creator = trimHyphens(normalizeHandle(creatorSlug));
  const persona = trimHyphens(normalizeHandle(personaSlug));
  const personaRoom = Math.max(
    MIN_PERSONA_PART_LENGTH,
    budget - creator.length - 1,
  );
  const personaPart = trimHyphens(persona.slice(0, personaRoom));
  const creatorPart = trimHyphens(
    creator.slice(0, budget - personaPart.length - 1),
  );
  return `${creatorPart}-${personaPart}${tail}`;
}

/** The first well-formed, non-reserved, available candidate. */
export async function deriveLinkedPersonaHandle(
  creatorSlug: string,
  personaSlug: string,
  isAvailable: (candidate: string) => Promise<boolean>,
): Promise<string> {
  for (let suffix = 1; suffix <= MAX_DERIVATION_SUFFIX; suffix += 1) {
    const candidate = linkedPersonaHandleCandidate(
      creatorSlug,
      personaSlug,
      suffix,
    );
    if (handleFormatError(candidate) !== null) continue;
    if (await isAvailable(candidate)) return candidate;
  }
  throw new ConflictException({
    code: 'handle_derivation_failed',
    message: 'We could not find a free address for this persona.',
  });
}

/**
 * True when `handle` carries the creator's profile slug as a whole
 * hyphen-delimited run, as written or with its hyphens squashed. An unlinked
 * persona may not use such a handle: it would say who runs it.
 */
export function handleNamesOwner(handle: string, creatorSlug: string): boolean {
  const paddedHandle = `-${normalizeHandle(handle)}-`;
  const creator = trimHyphens(normalizeHandle(creatorSlug));
  if (!creator) return false;
  const squashedCreator = creator.replace(/-/g, '');
  return (
    paddedHandle.includes(`-${creator}-`) ||
    (squashedCreator.length >= MIN_PERSONA_PART_LENGTH &&
      paddedHandle.includes(`-${squashedCreator}-`))
  );
}

/** A label as a handle-shaped slug, accents folded first ("Cerâmica" ->
 *  "ceramica"): lowercase, runs of anything else become one hyphen. */
function kindNameSlug(label: string): string {
  return label
    .normalize('NFD')
    .replace(/\p{Mark}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * True when `handle` is only the persona's own kind: its id with hyphens
 * ("therapist", "visual-artist") or its EN or PT label ("terapia"), the first
 * two entries of `KIND_SEARCH_TERMS`. A persona's `/p/` address has to name
 * the persona, so publish refuses the bare profession (`handle_is_kind`). The
 * frontend mirrors this in `src/features/subprofiles/personaHandle.ts`; change
 * both together.
 */
export function handleIsKindName(
  handle: string,
  kind: SubprofileKind,
): boolean {
  const normalizedHandle = normalizeHandle(handle);
  if (!normalizedHandle) return false;
  const [englishLabel = '', portugueseLabel = ''] = KIND_SEARCH_TERMS[kind];
  const kindNames = [
    kind.replace(/_/g, '-'),
    kindNameSlug(englishLabel),
    kindNameSlug(portugueseLabel),
  ];
  return kindNames.includes(normalizedHandle);
}
