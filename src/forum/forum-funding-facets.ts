import { type SelectQueryBuilder } from 'typeorm';
import { countByFilterClauses } from '../common/facet-counts';
import { ForumThread } from './entities/forum-thread.entity';
import {
  ASK_AUTO_END_MS,
  CALL_CLOSING_WINDOW_MS,
  FUNDING_ELIGIBILITIES,
  FUNDING_SCOPES,
  FUNDING_VIEWS,
  ROLLING_CALL_STALE_MS,
  type FundingEligibility,
  type FundingListFilter,
  type FundingScope,
  type FundingView,
} from './forum-funding';

// "Open or closing" for a call, shared by the `open` view, the duplicate
// lookup and the view facets so all three agree on which calls still count
// (`deriveCallState` is the row-level twin): a dated call whose deadline has
// not passed, or a rolling call edited within the stale window. Both
// boundaries use the comparisons `deriveCallState` uses, so a call exactly
// 183 days old or due this instant reads open in SQL and in the view alike.
export const OPEN_CALL_STATE_SQL =
  '(("funding"."deadline" IS NULL AND "funding"."updated_at" >= :rollingFreshAfter) OR "funding"."deadline" >= :fundingNow)';

export function openCallStateParameters(now: Date): {
  rollingFreshAfter: Date;
  fundingNow: Date;
} {
  return {
    rollingFreshAfter: new Date(now.getTime() - ROLLING_CALL_STALE_MS),
    fundingNow: now,
  };
}

/** The view row's "All" chip, which lifts the view. Never sent as a view. */
export const ALL_FUNDING_VIEW = 'all';
/** The scope row's "Anywhere" chip, which lifts the scope. */
export const ANY_FUNDING_SCOPE = 'any';

/**
 * `fundingFacets` on the first page of `GET /forum/threads?category=funding`:
 * how many threads each Funding & Grants chip would list, counted with that
 * chip row's own filter lifted and every other filter (q, tag, sort, the
 * other chip rows) still applied.
 *
 * - `view`: one count per view plus `all`. `open` and `closing` keep the
 *   eligibility and scope chips (the URL keeps them between the two call
 *   views); `asks`, `discussion` and `all` drop them, as switching to those
 *   views does. `all` is the category's distinct total, pinned threads
 *   included, the same number as the category badge.
 * - `eligibility`, `scope`: only on a call view (`open`, `closing`), else
 *   null. Eligibility is an any-of match, so one call counts under each
 *   eligibility it lists; `scope.any` is the distinct total of the view.
 */
export interface ForumFundingFacets {
  view: Record<typeof ALL_FUNDING_VIEW | FundingView, number>;
  eligibility: Record<FundingEligibility, number> | null;
  scope: Record<typeof ANY_FUNDING_SCOPE | FundingScope, number> | null;
}

/**
 * The thread-level predicates the view facets need and only the service
 * owns: the opening-post takedown check (`forumOpNotTakenDownSql('"t"')`) and
 * the approved review state.
 */
export interface FundingFacetGates {
  opNotTakenDownSql: string;
  approvedReviewState: string;
}

type CallView = 'open' | 'closing';

const HAS_FUNDING_SQL = '"funding"."thread_id" IS NOT NULL';
const CLOSING_CALL_STATE_SQL =
  '("funding"."deadline" >= :fundingNow AND "funding"."deadline" <= :closingUntil)';
const eligibilityMatchSql = (param: string) =>
  `"funding"."eligibility" && CAST(:${param} AS text[])`;
const scopeMatchSql = (param: string) => `"funding"."scope" = :${param}`;

/** One `COUNT(*) FILTER` column: its response slot and its predicate. */
interface FacetColumn {
  key: string;
  clause: (param: string) => string;
  parameter: unknown;
}

/** Every predicate below, written over `"t"` and the LEFT JOINed `"funding"`
 *  row, mirroring `ForumThreadsService.pageFundingView` term for term. */
function viewClauses(gates: FundingFacetGates) {
  const call = (stateSql: string) =>
    `${HAS_FUNDING_SQL} AND ${gates.opNotTakenDownSql} AND "t"."kind" = :facetCallKind AND ${stateSql}`;
  const callViews: Record<CallView, string> = {
    open: call(OPEN_CALL_STATE_SQL),
    closing: call(CLOSING_CALL_STATE_SQL),
  };
  const asks = `${HAS_FUNDING_SQL} AND ${gates.opNotTakenDownSql} AND "t"."kind" = :facetAskKind AND "t"."review_state" = :facetApprovedReview AND "t"."author_id" IS NOT NULL AND "t"."deleted_at" IS NULL AND "funding"."ended_at" IS NULL AND ("funding"."ends_at" >= :fundingNow OR ("funding"."ends_at" IS NULL AND ("funding"."approved_at" IS NULL OR "funding"."approved_at" >= :askAutoEndAfter)))`;
  // The discussion page leaves pinned threads to the pinned bucket, which
  // the funding views do not draw, so a pinned one is never on it.
  const discussion = `"funding"."thread_id" IS NULL AND "t"."is_pinned" = false`;
  return { callViews, asks, discussion };
}

/**
 * Counts every Funding & Grants facet in ONE aggregate scan.
 *
 * `qb` must already carry everything the list applies before its view
 * branch (block, community, deleted and published gates, `category =
 * funding`, q/tag, `unanswered`) plus `LEFT JOIN forum_thread_funding
 * "funding"`, which is one row per thread at most (`thread_id` is its primary
 * key), so `COUNT(*)` never double counts. It is mutated, so hand it a fresh
 * builder.
 */
export async function countFundingFacets(
  qb: SelectQueryBuilder<ForumThread>,
  filter: FundingListFilter,
  gates: FundingFacetGates,
  now: Date,
): Promise<ForumFundingFacets> {
  const { callViews, asks, discussion } = viewClauses(gates);
  const hasEligibility = !!filter.eligibility?.length;
  const eligibilityApplied = hasEligibility
    ? eligibilityMatchSql('facetEligibility')
    : 'TRUE';
  const scopeApplied = filter.scope ? scopeMatchSql('facetScope') : 'TRUE';
  qb.setParameters({
    ...openCallStateParameters(now),
    closingUntil: new Date(now.getTime() + CALL_CLOSING_WINDOW_MS),
    askAutoEndAfter: new Date(now.getTime() - ASK_AUTO_END_MS),
    facetCallKind: 'call',
    facetAskKind: 'ask',
    facetApprovedReview: gates.approvedReviewState,
    ...(hasEligibility ? { facetEligibility: filter.eligibility } : {}),
    ...(filter.scope ? { facetScope: filter.scope } : {}),
  });

  const viewSql: Record<FundingView, string> = {
    open: `${callViews.open} AND ${eligibilityApplied} AND ${scopeApplied}`,
    closing: `${callViews.closing} AND ${eligibilityApplied} AND ${scopeApplied}`,
    asks,
    discussion,
  };
  const columns: FacetColumn[] = [
    { key: `view:${ALL_FUNDING_VIEW}`, clause: () => 'TRUE', parameter: null },
    ...FUNDING_VIEWS.map((view) => ({
      key: `view:${view}`,
      clause: () => viewSql[view],
      parameter: null,
    })),
  ];
  const callView: CallView | null =
    filter.view === 'open' || filter.view === 'closing' ? filter.view : null;
  if (callView) {
    const inView = callViews[callView];
    columns.push(
      ...FUNDING_ELIGIBILITIES.map((eligibility) => ({
        key: `eligibility:${eligibility}`,
        clause: (param: string) =>
          `${inView} AND ${eligibilityMatchSql(param)} AND ${scopeApplied}`,
        parameter: [eligibility],
      })),
      {
        key: `scope:${ANY_FUNDING_SCOPE}`,
        clause: () => `${inView} AND ${eligibilityApplied}`,
        parameter: null,
      },
      ...FUNDING_SCOPES.map((scope) => ({
        key: `scope:${scope}`,
        clause: (param: string) =>
          `${inView} AND ${eligibilityApplied} AND ${scopeMatchSql(param)}`,
        parameter: scope,
      })),
    );
  }

  const columnsByKey = new Map(columns.map((column) => [column.key, column]));
  const counts = await countByFilterClauses(
    qb,
    columns.map((column) => column.key),
    (param, key) => `(${columnsByKey.get(key)?.clause(param) ?? 'FALSE'})`,
    (key) => columnsByKey.get(key)?.parameter ?? null,
  );
  const pick = <Option extends string>(
    prefix: string,
    options: readonly Option[],
  ) =>
    Object.fromEntries(
      options.map((option) => [option, counts[`${prefix}:${option}`] ?? 0]),
    ) as Record<Option, number>;

  return {
    view: pick('view', [ALL_FUNDING_VIEW, ...FUNDING_VIEWS]),
    eligibility: callView ? pick('eligibility', FUNDING_ELIGIBILITIES) : null,
    scope: callView
      ? pick('scope', [ANY_FUNDING_SCOPE, ...FUNDING_SCOPES])
      : null,
  };
}
