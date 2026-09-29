/**
 * Mapping tables and SQL builders for migration
 * `WorkTaxonomyJobIdsAndFieldMoves1825100000000` (see that file's doc
 * comment for what each table means and why they are frozen literals).
 *
 * Lives in `src/database`, outside `src/migrations`: TypeORM requires every
 * `src/migrations/*.ts` file and calls `new` on every exported function as
 * if it were a migration class, so an exported helper there crashes app boot
 * (`new mapColumnSql()` with no arguments). Same convention as
 * `repair-orphaned-persona-creators.sql.ts`.
 */

export const JOB_FIELD_IDS_AT_MIGRATION = [
  'design',
  'fashion',
  'editorial',
  'languages',
  'marketing',
  'tech',
  'engineering',
  'science',
  'architecture',
  'healthcare',
  'care',
  'education',
  'legal',
  'finance',
  'people',
  'operations',
  'management',
  'sales',
  'customerService',
  'realEstate',
  'retail',
  'food',
  'hospitality',
  'nightlife',
  'photo',
  'film',
  'performance',
  'music',
  'curation',
  'craft',
  'beauty',
  'wellness',
  'sport',
  'animals',
  'trades',
  'manufacturing',
  'transport',
  'farming',
  'facilities',
  'security',
  'community',
  'publicSector',
  'faith',
];

export const COMMITMENT_IDS_AT_MIGRATION = [
  'fullTime',
  'partTime',
  'contract',
  'freelanceGig',
  'volunteer',
  'internship',
];

export const SENIORITY_IDS_AT_MIGRATION = [
  'anyLevel',
  'entry',
  'mid',
  'senior',
  'leadPrincipal',
];

export const LEGACY_CATEGORY_TO_FIELD: Record<string, string> = {
  'legal & admin': 'legal',
  'design & creative': 'design',
  'tech & engineering': 'tech',
  'writing & editing': 'editorial',
  translation: 'languages',
  'teaching & tutoring': 'education',
  'health & wellbeing': 'healthcare',
  // Seed and demo labels.
  design: 'design',
  engineering: 'engineering',
  'community & advocacy': 'community',
  'programme & operations': 'operations',
  retail: 'retail',
};

export const LEGACY_COMMITMENT_TO_ID: Record<string, string> = {
  'full-time': 'fullTime',
  'part-time': 'partTime',
  contract: 'contract',
  'freelance / gig': 'freelanceGig',
  freelance: 'freelanceGig',
  volunteer: 'volunteer',
  internship: 'internship',
};

export const LEGACY_SENIORITY_TO_ID: Record<string, string> = {
  'any level': 'anyLevel',
  entry: 'entry',
  junior: 'entry',
  mid: 'mid',
  senior: 'senior',
  'lead / principal': 'leadPrincipal',
  lead: 'leadPrincipal',
};

/** Canonical English label per id, for `down()`. Only the seven original
 *  categories had a canonical legacy label; every other field id becomes
 *  'Other' on the way back (see `reverseMapColumnSql` call in `down()`). */
export const FIELD_TO_LEGACY_CATEGORY: Record<string, string> = {
  legal: 'Legal & admin',
  design: 'Design & creative',
  tech: 'Tech & engineering',
  editorial: 'Writing & editing',
  languages: 'Translation',
  education: 'Teaching & tutoring',
  healthcare: 'Health & wellbeing',
};

/** English labels the old frontend commitment/seniority lists used, for
 *  `down()`. Every id maps back cleanly: none of these were ever lossy. */
export const LEGACY_COMMITMENT_LABEL_BY_ID: Record<string, string> = {
  fullTime: 'Full-time',
  partTime: 'Part-time',
  contract: 'Contract',
  freelanceGig: 'Freelance / gig',
  volunteer: 'Volunteer',
  internship: 'Internship',
};

export const LEGACY_SENIORITY_LABEL_BY_ID: Record<string, string> = {
  anyLevel: 'Any level',
  entry: 'Entry',
  mid: 'Mid',
  senior: 'Senior',
  leadPrincipal: 'Lead / Principal',
};

export const PROFESSION_MOVES: ReadonlyArray<{
  profession: string;
  from: string;
  to: string;
}> = [
  { profession: 'receptionist', from: 'retail', to: 'operations' },
  { profession: 'cleaner', from: 'retail', to: 'facilities' },
  { profession: 'securityGuard', from: 'retail', to: 'security' },
  { profession: 'customerSupport', from: 'retail', to: 'customerService' },
  { profession: 'firefighter', from: 'publicSector', to: 'security' },
  { profession: 'policeOfficer', from: 'publicSector', to: 'security' },
  { profession: 'socialWorker', from: 'publicSector', to: 'community' },
  { profession: 'youthWorker', from: 'publicSector', to: 'community' },
  { profession: 'nonprofitDirector', from: 'publicSector', to: 'community' },
  { profession: 'ngoProgrammeLead', from: 'publicSector', to: 'community' },
  {
    profession: 'volunteerCoordinator',
    from: 'publicSector',
    to: 'community',
  },
  { profession: 'consultant', from: 'ownBusiness', to: 'management' },
  { profession: 'logisticsCoordinator', from: 'operations', to: 'transport' },
  { profession: 'eventOperations', from: 'operations', to: 'nightlife' },
  { profession: 'researcher', from: 'education', to: 'science' },
  { profession: 'fundraiser', from: 'finance', to: 'community' },
  { profession: 'estateAgent', from: 'sales', to: 'realEstate' },
  {
    profession: 'customerSuccessManager',
    from: 'sales',
    to: 'customerService',
  },
  { profession: 'translator', from: 'editorial', to: 'languages' },
];

/** The professions under each old field after the moves, including any moved
 *  in, that existed under that field before this migration (current ids
 *  only: new professions cannot be held yet). Guards the old-field removal. */
export const REMAINING_PROFESSIONS_BY_OLD_FIELD: Record<
  string,
  readonly string[]
> = {
  retail: [
    'shopAssistant',
    'florist',
    'bookseller',
    'storeManager',
    'visualMerchandiser',
  ],
  publicSector: [
    'policyAdvisor',
    'civilServant',
    'electedOfficial',
    'diplomat',
  ],
  ownBusiness: ['founder', 'smallBusinessOwner', 'freelancer', 'coopMember'],
  operations: [
    'operationsManager',
    'projectManager',
    'programmeCoordinator',
    'officeManager',
    'executiveAssistant',
    'receptionist',
  ],
  education: [
    'teacher',
    'workshopFacilitator',
    'tutor',
    'lecturer',
    'sexEducator',
    'languageTeacher',
    'earlyYearsEducator',
    'specialNeedsTeacher',
  ],
  finance: [
    'accountant',
    'bookkeeper',
    'financialAnalyst',
    'financialAdviser',
    'taxAdviser',
    'auditor',
  ],
  sales: ['accountExecutive', 'businessDevelopment', 'salesRepresentative'],
  editorial: [
    'editor',
    'journalist',
    'copywriter',
    'poet',
    'podcaster',
    'author',
    'contentCreator',
    'zinester',
    'publisher',
  ],
};

const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const sqlArray = (values: readonly string[]): string =>
  `ARRAY[${values.map(sqlString).join(', ')}]::text[]`;

export function mapColumnSql(
  column: string,
  labelToId: Record<string, string>,
  knownIds: readonly string[],
  fallbackId: string | null,
): string {
  const whens = Object.entries(labelToId)
    .map(
      ([label, id]) =>
        `WHEN lower(trim(${column})) = ${sqlString(label)} THEN ${sqlString(id)}`,
    )
    .join(' ');
  const fallback = fallbackId === null ? 'NULL' : sqlString(fallbackId);
  return `CASE WHEN ${column} IN (${knownIds.map(sqlString).join(', ')}) THEN ${column} ${whens} ELSE ${fallback} END`;
}

/** `down()`'s counterpart to `mapColumnSql`: a plain id-to-label CASE, with
 *  every id absent from `idToLabel` (and any other stored value) falling
 *  back to `defaultLabel`. */
export function reverseMapColumnSql(
  column: string,
  idToLabel: Record<string, string>,
  defaultLabel: string,
): string {
  const whens = Object.entries(idToLabel)
    .map(
      ([id, label]) =>
        `WHEN ${column} = ${sqlString(id)} THEN ${sqlString(label)}`,
    )
    .join(' ');
  return `CASE ${whens} ELSE ${sqlString(defaultLabel)} END`;
}

export function profileMoveSql(): string[] {
  const addNewField = PROFESSION_MOVES.map(
    ({ profession, to }) =>
      `UPDATE "profiles" SET "discipline" = array_append("discipline", ${sqlString(to)}) ` +
      `WHERE ${sqlString(profession)} = ANY("profession") AND NOT (${sqlString(to)} = ANY("discipline"))`,
  );
  const oldFields = [...new Set(PROFESSION_MOVES.map((move) => move.from))];
  const dropOldField = oldFields.map((from) => {
    const moved = PROFESSION_MOVES.filter((move) => move.from === from).map(
      (move) => move.profession,
    );
    const remaining = REMAINING_PROFESSIONS_BY_OLD_FIELD[from] ?? [];
    return (
      `UPDATE "profiles" SET "discipline" = array_remove("discipline", ${sqlString(from)}) ` +
      `WHERE ${sqlString(from)} = ANY("discipline") AND "profession" && ${sqlArray(moved)}` +
      (remaining.length
        ? ` AND NOT ("profession" && ${sqlArray(remaining)})`
        : '')
    );
  });
  return [...addNewField, ...dropOldField];
}
