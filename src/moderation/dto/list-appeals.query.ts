import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * `GET /mod/appeals` query — matches `ModAppealsParams` in
 * `queerpulse/src/features/admin/api/moderation.api.ts`.
 *
 * The endpoint used to take no query at all: one unfiltered, unpaginated
 * `find` capped at 200 rows with decided appeals mixed in among the awaiting
 * ones, newest first. That ordering is the wrong one for a queue with a
 * deadline: the appeal closest to breaching its window is the oldest, so it sat
 * at the bottom of the list, under every appeal that still had a week to run.
 */
const APPEAL_TABS = ['awaiting', 'decided'] as const;
export type ModAppealsTab = (typeof APPEAL_TABS)[number];

/**
 * `overdue` is "the 7-day decision window has already closed and nobody has
 * decided it". It only ever narrows the awaiting tab: a decided appeal has no
 * window left to be outside of, and whether it was decided late is a fact about
 * its own row (`decidedAt` against `slaDueAt`) rather than a queue filter.
 */
const APPEAL_FILTERS = ['all', 'overdue'] as const;
export type ModAppealsFilter = (typeof APPEAL_FILTERS)[number];

export class ListAppealsQuery {
  @IsOptional()
  @IsIn(APPEAL_TABS)
  tab?: ModAppealsTab;

  @IsOptional()
  @IsIn(APPEAL_FILTERS)
  filter?: ModAppealsFilter;

  @IsOptional()
  @IsString()
  cursor?: string;

  // Server-side-only knob, matching `ListModReportsQuery.limit`: the frontend
  // never sends one, and the whitelist only rejects undeclared fields a client
  // actually sends.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
