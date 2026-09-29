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
 * Unlike identities, there is no private/published split for most of this
 * taxonomy: a listed discipline/profession is a professional-identity fact in
 * the same spirit as `tags` (skills), set once and shown on every card that
 * shows the rest of the profile (ungated by profile visibility, like `tags`).
 * The one exception is `adultWork` and its six professions: unlisted work
 * stays off every list surface, and on the full profile it shows only to the
 * owner and to the owner's accepted connections, whatever the profile's own
 * visibility tier says. See UNLISTED_DISCIPLINE_IDS below.
 */
export const PROFESSIONS_BY_DISCIPLINE: Record<string, readonly string[]> = {
  design: [
    'graphicDesigner',
    'uxDesigner',
    'illustrator',
    'artDirector',
    'productDesigner',
    'webDesigner',
    'motionDesigner',
    'animator',
    'comicArtist',
    'uxResearcher',
  ],
  fashion: [
    'fashionDesigner',
    'stylist',
    'model',
    'costumeDesigner',
    'tailor',
    'patternCutter',
    'fashionBuyer',
    'vintageReseller',
  ],
  editorial: [
    'editor',
    'journalist',
    'copywriter',
    'translator',
    'poet',
    'podcaster',
    'author',
    'contentCreator',
    'zinester',
    'publisher',
  ],
  healthcare: [
    'therapist',
    'psychologist',
    'nurse',
    'gp',
    'physiotherapist',
    'peerCounsellor',
    'communityHealthWorker',
    'psychiatrist',
    'hospitalDoctor',
    'pharmacist',
    'midwife',
    'doula',
    'dentist',
    'occupationalTherapist',
    'speechTherapist',
    'nutritionist',
    'sexTherapist',
    'sexualHealthWorker',
    'harmReductionWorker',
    'paramedic',
  ],
  legal: [
    'immigrationLawyer',
    'familyLawyer',
    'paralegal',
    'legalAdvocate',
    'humanRightsLawyer',
    'employmentLawyer',
    'criminalLawyer',
    'notary',
    'mediator',
  ],
  education: [
    'teacher',
    'workshopFacilitator',
    'researcher',
    'tutor',
    'lecturer',
    'sexEducator',
    'languageTeacher',
    'earlyYearsEducator',
    'specialNeedsTeacher',
  ],
  tech: [
    'softwareEngineer',
    'backendEngineer',
    'dataScientist',
    'productManager',
    'frontendEngineer',
    'fullStackEngineer',
    'mobileEngineer',
    'devOpsEngineer',
    'qaEngineer',
    'securityEngineer',
    'dataAnalyst',
    'machineLearningEngineer',
    'itSupport',
    'technicalWriter',
  ],
  engineering: [
    'civilEngineer',
    'mechanicalEngineer',
    'electricalEngineer',
    'environmentalEngineer',
    'aerospaceEngineer',
    'biomedicalEngineer',
  ],
  marketing: [
    'marketingManager',
    'brandStrategist',
    'socialMediaManager',
    'contentStrategist',
    'prCommunications',
    'growthMarketer',
    'communityManager',
  ],
  operations: [
    'operationsManager',
    'projectManager',
    'programmeCoordinator',
    'officeManager',
    'executiveAssistant',
    'eventOperations',
    'logisticsCoordinator',
  ],
  people: [
    'hrGeneralist',
    'recruiter',
    'hrBusinessPartner',
    'learningDevelopment',
    'deiLead',
    'payrollBenefits',
  ],
  finance: [
    'accountant',
    'bookkeeper',
    'financialAnalyst',
    'fundraiser',
    'financialAdviser',
    'taxAdviser',
    'auditor',
  ],
  sales: [
    'accountExecutive',
    'businessDevelopment',
    'customerSuccessManager',
    'salesRepresentative',
    'estateAgent',
  ],
  ownBusiness: [
    'founder',
    'smallBusinessOwner',
    'freelancer',
    'consultant',
    'coopMember',
  ],
  photo: [
    'portraitPhotographer',
    'photojournalist',
    'retoucher',
    'eventPhotographer',
    'fashionPhotographer',
  ],
  film: [
    'documentaryFilmmaker',
    'filmmaker',
    'cinematographer',
    'filmEditor',
    'screenwriter',
    'filmProducer',
    'videographer',
  ],
  performance: [
    'choreographer',
    'dancer',
    'theatreMaker',
    'performanceArtist',
    'voiceActor',
    'actor',
    'dragPerformer',
    'comedian',
    'burlesquePerformer',
    'circusArtist',
    'hostEmcee',
    'voguer',
    'poleDancer',
    'spokenWordArtist',
    'danceTeacher',
  ],
  music: [
    'musicProducer',
    'dj',
    'sessionMusician',
    'soundDesigner',
    'musicIndustryAR',
    'singer',
    'songwriter',
    'composer',
    'musicTeacher',
    'soundEngineer',
  ],
  nightlife: [
    'promoter',
    'eventProducer',
    'eventPlanner',
    'venueManager',
    'doorHost',
    'stageTechnician',
    'celebrant',
  ],
  architecture: [
    'architect',
    'urbanDesigner',
    'interiorArchitect',
    'landscapeArchitect',
  ],
  community: [
    'communityOrganiser',
    'housingOrganiser',
    'housingAdvocate',
    'supportCoordinator',
    'accessibilityAdvocate',
    'activist',
    'communityCentreCoordinator',
  ],
  publicSector: [
    'socialWorker',
    'youthWorker',
    'policyAdvisor',
    'civilServant',
    'nonprofitDirector',
    'ngoProgrammeLead',
    'volunteerCoordinator',
    'electedOfficial',
    'diplomat',
    'firefighter',
    'policeOfficer',
  ],
  curation: [
    'curator',
    'archivist',
    'galleryDirector',
    'librarian',
    'historian',
    'conservator',
    'artCritic',
    'exhibitionDesigner',
    'museumEducator',
  ],
  food: [
    'chef',
    'barista',
    'baker',
    'supperClubHost',
    'bartender',
    'waiter',
    'cook',
    'sommelier',
    'brewer',
    'caterer',
    'restaurantManager',
  ],
  hospitality: [
    'hotelManager',
    'frontDeskAgent',
    'housekeeper',
    'tourGuide',
    'travelAgent',
    'guesthouseHost',
  ],
  craft: [
    'ceramicist',
    'woodworker',
    'textileArtist',
    'jeweller',
    'printmaker',
    'leatherworker',
  ],
  beauty: [
    'barber',
    'hairdresser',
    'makeupArtist',
    'nailTechnician',
    'beautician',
    'tattooArtist',
    'piercer',
    'wigMaker',
    'lashBrowTechnician',
  ],
  trades: [
    'electrician',
    'plumber',
    'carpenter',
    'mechanic',
    'painterDecorator',
    'constructionWorker',
    'gardener',
    'welder',
    'tiler',
    'handyperson',
  ],
  farming: ['farmer', 'winemaker', 'permacultureDesigner', 'beekeeper'],
  care: [
    'homeCareWorker',
    'childcareWorker',
    'disabilitySupportWorker',
    'funeralDirector',
  ],
  animals: [
    'vet',
    'vetNurse',
    'dogWalker',
    'petGroomer',
    'dogTrainer',
    'animalShelterWorker',
  ],
  wellness: [
    'personalTrainer',
    'yogaTeacher',
    'massageTherapist',
    'lifeCoach',
    'pilatesInstructor',
    'meditationTeacher',
    'astrologer',
  ],
  sport: [
    'athlete',
    'sportsCoach',
    'referee',
    'surfInstructor',
    'climbingInstructor',
  ],
  retail: [
    'shopAssistant',
    'receptionist',
    'cleaner',
    'securityGuard',
    'customerSupport',
    'florist',
    'bookseller',
    'storeManager',
    'visualMerchandiser',
  ],
  transport: [
    'driver',
    'deliveryRider',
    'warehouseWorker',
    'pilot',
    'flightAttendant',
  ],
  science: [
    'biologist',
    'ecologist',
    'labResearcher',
    'chemist',
    'physicist',
    'environmentalScientist',
    'mathematician',
  ],
  games: [
    'gameMaster',
    'ttrpgWriter',
    'gameDesigner',
    'boardGameReviewer',
    'gameNightHost',
    'larpOrganiser',
    'miniaturePainter',
    'cosplayer',
    'streamer',
    'tournamentOrganiser',
    'actualPlayPerformer',
    'fantasyCartographer',
    'diceMaker',
    'propMaker',
    'puzzleDesigner',
    'speedrunner',
    'modder',
    'fanficWriter',
    'gameCritic',
  ],
  // Selectable, but the directory must never become a way to list sex
  // workers, since that could out someone. A member may name this work on
  // their own profile. See UNLISTED_DISCIPLINE_IDS below for the
  // enforcement; this discipline stays in PROFESSIONS_BY_DISCIPLINE and every
  // full-set export because saving must accept these ids like any other.
  adultWork: [
    'sexWorker',
    'adultContentCreator',
    'camPerformer',
    'exoticDancer',
    'professionalDominant',
    'adultFilmPerformer',
  ],
  lifeStage: [
    'student',
    'apprentice',
    'betweenJobs',
    'fullTimeCarer',
    'retired',
  ],
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

/**
 * `adultWork` (Sex work & adult content) is selectable, but never usable to
 * find people. A member can save it on their own profile; it shows on their
 * FULL profile to themself always, and to another viewer only when that
 * viewer is an accepted connection (coordinator ruling 15). The profile's
 * own `open`/`network`/`private` visibility tier alone is not enough: an
 * `open` profile is full to every signed-in member, which would make the
 * directory a slug sweep away from rebuilding the list this feature exists
 * to prevent. It must never become a way to LIST or COUNT those members: no
 * chip filter, no facet count, no text-search match, no "people like you"
 * suggestion signal, no related-people signal, nothing on directory cards or
 * other list surfaces shown to other members. Naming this work in a
 * searchable index could out someone as a sex worker to anyone who happened
 * to filter or search for it.
 *
 * `DISCIPLINE_IDS`, `ALL_PROFESSION_IDS` in the DTO, `knownDisciplines`/
 * `knownProfessions` and `reconcileDisciplineProfession` above all keep the
 * FULL set on purpose: saving a profile must keep accepting the unlisted
 * ids. Every LIST/SEARCH/COUNT/SUGGEST path uses the `listed*` helpers below
 * instead.
 */
export const UNLISTED_DISCIPLINE_IDS: readonly string[] = ['adultWork'];

const UNLISTED_DISCIPLINE_SET: ReadonlySet<string> = new Set(
  UNLISTED_DISCIPLINE_IDS,
);

export const LISTED_DISCIPLINE_IDS: readonly string[] = DISCIPLINE_IDS.filter(
  (id) => !UNLISTED_DISCIPLINE_SET.has(id),
);

export const LISTED_PROFESSION_IDS: readonly string[] = Object.keys(
  DISCIPLINE_BY_PROFESSION,
).filter(
  (profession) =>
    !UNLISTED_DISCIPLINE_SET.has(DISCIPLINE_BY_PROFESSION[profession]!),
);

const LISTED_DISCIPLINE_SET: ReadonlySet<string> = new Set(
  LISTED_DISCIPLINE_IDS,
);
const LISTED_PROFESSION_SET: ReadonlySet<string> = new Set(
  LISTED_PROFESSION_IDS,
);

/** Like `knownDisciplines`, but also drops unlisted disciplines: the id must
 *  be real AND listed, so an `adultWork` request is indistinguishable from an
 *  unknown one to every list/search/count/suggest path. */
export function listedDisciplines(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => LISTED_DISCIPLINE_SET.has(id)))];
}

/** Like `knownProfessions`, but also drops professions of an unlisted
 *  discipline (the six `adultWork` professions). See `listedDisciplines`. */
export function listedProfessions(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => LISTED_PROFESSION_SET.has(id)))];
}

/**
 * Copies of `work.discipline`/`work.profession` with every unlisted
 * discipline and unlisted profession removed. Applied by `toProfileCard`
 * (see its `shouldIncludeUnlistedWork` option) to every card except the
 * owner's own and a full-profile read by an accepted connection. See the
 * `UNLISTED_DISCIPLINE_IDS` comment above and coordinator ruling 15.
 */
export function withoutUnlistedWork(work: {
  discipline: string[];
  profession: string[];
}): { discipline: string[]; profession: string[] } {
  return {
    discipline: work.discipline.filter((id) => LISTED_DISCIPLINE_SET.has(id)),
    profession: work.profession.filter((id) => LISTED_PROFESSION_SET.has(id)),
  };
}

/**
 * Whether this stored discipline/profession selection includes any unlisted
 * (`adultWork`) id. `ProfilesService` uses this to skip the extra
 * `ConnectionsService.areConnected` call for the overwhelming majority of
 * profiles that never selected unlisted work, so gating the full-profile
 * read costs nothing beyond the existing query for every ordinary profile.
 */
export function hasUnlistedWork(work: {
  discipline: string[];
  profession: string[];
}): boolean {
  // `?? []` mirrors `toProfileCard`'s defensive read of the same columns:
  // a row with nothing saved yet safely reads as "no unlisted work".
  return (
    (work.discipline ?? []).some((id) => UNLISTED_DISCIPLINE_SET.has(id)) ||
    (work.profession ?? []).some((id) =>
      UNLISTED_DISCIPLINE_SET.has(DISCIPLINE_BY_PROFESSION[id] ?? ''),
    )
  );
}
