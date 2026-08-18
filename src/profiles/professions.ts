/**
 * The discipline/profession taxonomy, server-side. Sibling of `identities.ts`
 * and `open-to.ts`, and here for the same reason: these ids are the wire
 * contract between `profiles.discipline`/`profiles.profession` (what a member
 * sets about themselves) and `GET /members?disciplines=&professions=` (what
 * other members search on) — the SAME ids must drive both, or the filter goes
 * quietly dark the way the identity filter once did (see
 * AddDiscoverableIdentities1782800770000). Mirrors `DISCIPLINES` /
 * `PROFESSIONS_BY_FIELD` in the frontend's `memberDirectoryFilter.data.ts` —
 * keep the two in lockstep; this list is the authority and the DTO rejects
 * anything outside it.
 *
 * Unlike identities, there is no private/published split here: a member's
 * discipline and profession are professional-identity facts in the same
 * spirit as `tags` (skills) — set once, visible whenever the card is
 * (ungated by profile visibility, like `tags`).
 */
export const PROFESSIONS_BY_DISCIPLINE: Record<string, readonly string[]> = {
  design: ['graphicDesigner', 'uxDesigner', 'illustrator', 'artDirector'],
  editorial: ['editor', 'journalist', 'copywriter', 'translator', 'poet'],
  healthcare: [
    'therapist',
    'psychologist',
    'nurse',
    'gp',
    'physiotherapist',
    'peerCounsellor',
    'communityHealthWorker',
  ],
  legal: ['immigrationLawyer', 'familyLawyer', 'paralegal', 'legalAdvocate'],
  education: ['teacher', 'workshopFacilitator', 'researcher', 'tutor'],
  tech: [
    'softwareEngineer',
    'backendEngineer',
    'dataScientist',
    'productManager',
  ],
  photo: ['portraitPhotographer', 'photojournalist', 'retoucher'],
  film: ['documentaryFilmmaker', 'filmmaker', 'cinematographer', 'filmEditor'],
  performance: ['choreographer', 'dancer', 'theatreMaker', 'performanceArtist'],
  music: [
    'musicProducer',
    'dj',
    'sessionMusician',
    'soundDesigner',
    'musicIndustryAR',
  ],
  architecture: ['architect', 'urbanDesigner', 'interiorArchitect'],
  community: [
    'communityOrganiser',
    'housingOrganiser',
    'housingAdvocate',
    'supportCoordinator',
    'accessibilityAdvocate',
    'activist',
  ],
  curation: ['curator', 'archivist', 'galleryDirector'],
  food: ['chef', 'barista', 'baker', 'supperClubHost'],
  craft: ['ceramicist', 'woodworker', 'textileArtist'],
  science: ['biologist', 'ecologist', 'labResearcher'],
};

export const DISCIPLINE_IDS = Object.keys(PROFESSIONS_BY_DISCIPLINE);

const DISCIPLINE_SET: ReadonlySet<string> = new Set(DISCIPLINE_IDS);

/** Reverse lookup: which discipline id a profession id belongs to. */
export const DISCIPLINE_BY_PROFESSION: Record<string, string> =
  Object.fromEntries(
    Object.entries(PROFESSIONS_BY_DISCIPLINE).flatMap(([discipline, profs]) =>
      profs.map((profession) => [profession, discipline]),
    ),
  );

const PROFESSION_SET: ReadonlySet<string> = new Set(
  Object.keys(DISCIPLINE_BY_PROFESSION),
);

export function isDisciplineId(value: string): boolean {
  return DISCIPLINE_SET.has(value);
}

export function isProfessionId(value: string): boolean {
  return PROFESSION_SET.has(value);
}

/** Keep only the ids that are actually in the taxonomy — an unrecognised id
 *  submitted by a stale/malicious client is dropped, not stored. */
export function knownDisciplines(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(isDisciplineId))];
}

export function knownProfessions(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(isProfessionId))];
}

/**
 * A profession implies its parent discipline. Mirrors the frontend's
 * `reconcileProfessions`/`toggleProfession` invariant so the same rule holds
 * whether a member is picking their OWN discipline/profession in Settings or
 * filtering the directory by one: keeps `profession ⊆ discipline` coherent
 * without rejecting the write — auto-adds the missing parent rather than
 * erroring, since forgetting to also tick the parent field is a normal slip,
 * not a hostile input.
 */
export function reconcileDisciplineProfession(
  disciplines: readonly string[],
  professions: readonly string[],
): { disciplines: string[]; professions: string[] } {
  const known = knownProfessions(professions);
  const impliedDisciplines = known.map((p) => DISCIPLINE_BY_PROFESSION[p]!);
  return {
    disciplines: [
      ...new Set([...knownDisciplines(disciplines), ...impliedDisciplines]),
    ],
    professions: known,
  };
}
