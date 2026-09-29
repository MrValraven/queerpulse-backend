/**
 * Job commitment and seniority ids: the wire values for `Job.commitment` and
 * `Job.seniority`. Labels live in the frontend catalog under
 * `economy:postJob.option.commitment.<id>` / `.seniority.<id>`. Mirrored in
 * the frontend's `features/economy/jobVocabulary.data.ts`, and the frontend's
 * `scripts/check-work-taxonomy.mjs` fails when the two drift.
 */
export const JOB_COMMITMENT_IDS = [
  'fullTime',
  'partTime',
  'contract',
  'freelanceGig',
  'volunteer',
  'internship',
] as const;
export type JobCommitmentId = (typeof JOB_COMMITMENT_IDS)[number];

export const JOB_SENIORITY_IDS = [
  'anyLevel',
  'entry',
  'mid',
  'senior',
  'leadPrincipal',
] as const;
export type JobSeniorityId = (typeof JOB_SENIORITY_IDS)[number];
