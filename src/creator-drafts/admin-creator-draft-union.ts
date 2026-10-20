import { PAGE_SIZE } from '../common/pagination';
import {
  CREATOR_DRAFT_KINDS,
  CREATOR_DRAFT_KIND_FEATURE,
  CreatorDraftKind,
  CreatorDraftVisibility,
  NoticeGatedCreatorDraftKind,
} from './creator-drafts.constants';

/**
 * The Admin creator drafts read: one `UNION ALL` across `subprofiles`,
 * `studio_releases`, `studio_tracks`, `listing_drafts` and `creator_drafts`.
 * The same branches answer the list, its count and the detail scope (with an
 * id filter), so the notice gate, the expiry and the feature gate live here.
 *
 * Every value reaches Postgres as a positional parameter; the SQL text holds
 * only the fixed branch templates for kinds taken from `CREATOR_DRAFT_KINDS`.
 */

export interface CreatorDraftScope {
  kinds: readonly CreatorDraftKind[];
  noticeLiveSince: Readonly<Record<NoticeGatedCreatorDraftKind, string | null>>;
  /** Stored rows saved before this instant are expired. */
  expiryCutoff: Date;
  /** Narrows every branch to one row id, for the detail read. */
  draftId?: string;
}

export interface CreatorDraftUnionRow {
  kind: CreatorDraftKind;
  id: string;
  owner_user_id: string;
  last_saved_at: Date;
}

export interface PositionalQuery {
  sql: string;
  parameters: unknown[];
}

type BindParameter = (value: unknown) => string;

interface BranchTemplate {
  /** The alias whose `"id"` is the draft id. */
  rowAlias: string;
  from: string;
  ownerColumn: string;
  savedColumn: string;
  /** Fixed conditions, joined with AND. */
  conditions: readonly string[];
  /** Stored rows expire; persona, Studio and listing drafts never do. */
  isExpiring: boolean;
}

const STORED_FROM = '"creator_drafts" "stored"';
/** A persona that is removed or private shows nowhere, so neither do its drafts or releases. */
const PERSONA_IN_SCOPE = [
  '"persona"."removed_at" IS NULL',
  `"persona"."visibility" <> 'private'`,
] as const;
/** Paused accounts and members in the deletion grace are promised hidden; suspended ones stay listed. */
const AUTHOR_IN_SCOPE = `"author"."status" <> 'deactivated'`;
const STORED_OWNER = '"stored"."user_id"';
const STORED_SAVED = '"stored"."updated_at"';
/**
 * A listing edit shows only while its author still owns the listing or
 * actively co-manages it, the same check the creator routes make, so staff
 * never read a draft its own author can no longer reach.
 */
const LISTING_EDIT_AUTHOR_MANAGES = `EXISTS (SELECT 1 FROM "listings" "managed" WHERE "managed"."id" = "stored"."made_for_listing_id" AND ("managed"."owner_id" = "stored"."user_id" OR EXISTS (SELECT 1 FROM "listing_co_managers" "co_manager" WHERE "co_manager"."listing_id" = "managed"."id" AND "co_manager"."user_id" = "stored"."user_id" AND "co_manager"."status" = 'active')))`;

const BRANCH_TEMPLATES: Readonly<Record<CreatorDraftKind, BranchTemplate>> = {
  persona: {
    rowAlias: 'persona',
    from: '"subprofiles" "persona"',
    ownerColumn: '"persona"."user_id"',
    savedColumn: '"persona"."updated_at"',
    conditions: [`"persona"."status" = 'draft'`, ...PERSONA_IN_SCOPE],
    isExpiring: false,
  },
  studio_release: {
    rowAlias: 'release',
    from: '"studio_releases" "release" JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"',
    ownerColumn: '"persona"."user_id"',
    savedColumn: '"release"."updated_at"',
    conditions: [
      `"release"."status" IN ('draft', 'scheduled')`,
      ...PERSONA_IN_SCOPE,
    ],
    isExpiring: false,
  },
  studio_episode: {
    rowAlias: 'track',
    from: '"studio_tracks" "track" JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id" JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"',
    ownerColumn: '"persona"."user_id"',
    savedColumn: '"track"."updated_at"',
    conditions: [
      `"release"."type" = 'podcast'`,
      `"release"."status" = 'published'`,
      '"track"."published_at" IS NULL',
      ...PERSONA_IN_SCOPE,
    ],
    isExpiring: false,
  },
  listing: {
    rowAlias: 'draft',
    from: '"listing_drafts" "draft"',
    ownerColumn: '"draft"."user_id"',
    savedColumn: '"draft"."updated_at"',
    conditions: [],
    isExpiring: false,
  },
  event: {
    rowAlias: 'stored',
    from: STORED_FROM,
    ownerColumn: STORED_OWNER,
    savedColumn: STORED_SAVED,
    conditions: [
      `"stored"."kind" = 'event'`,
      '("stored"."made_for_community_id" IS NOT NULL OR "stored"."made_for_listing_id" IS NOT NULL)',
    ],
    isExpiring: true,
  },
  listing_edit: {
    rowAlias: 'stored',
    from: STORED_FROM,
    ownerColumn: STORED_OWNER,
    savedColumn: STORED_SAVED,
    conditions: [
      `"stored"."kind" = 'listing_edit'`,
      '"stored"."made_for_listing_id" IS NOT NULL',
      LISTING_EDIT_AUTHOR_MANAGES,
    ],
    isExpiring: true,
  },
  community: {
    rowAlias: 'stored',
    from: STORED_FROM,
    ownerColumn: STORED_OWNER,
    savedColumn: STORED_SAVED,
    conditions: [`"stored"."kind" = 'community'`],
    isExpiring: true,
  },
};

/**
 * The kinds staff can see right now, narrowed to `requestedKind` when given.
 * A kind drops out when its feature is off or its notice date is null;
 * `listing` needs only its feature.
 */
export function enabledCreatorDraftKinds(
  requestedKind: CreatorDraftKind | undefined,
  visibility: CreatorDraftVisibility,
): CreatorDraftKind[] {
  return CREATOR_DRAFT_KINDS.filter((kind) => {
    if (requestedKind !== undefined && kind !== requestedKind) return false;
    const feature = CREATOR_DRAFT_KIND_FEATURE[kind];
    if (feature !== null && !visibility.isFeatureLaunched(feature)) {
      return false;
    }
    return kind === 'listing' || visibility.noticeLiveSince[kind] !== null;
  });
}

function noticeFor(
  kind: CreatorDraftKind,
  scope: CreatorDraftScope,
): string | null {
  return kind === 'listing' ? null : scope.noticeLiveSince[kind];
}

/** A gated kind with a null notice date reads no rows, whatever the caller passed. */
function isReadableKind(
  kind: CreatorDraftKind,
  scope: CreatorDraftScope,
): boolean {
  return kind === 'listing' || noticeFor(kind, scope) !== null;
}

function branchFor(
  kind: CreatorDraftKind,
  scope: CreatorDraftScope,
  bind: BindParameter,
): string {
  const template = BRANCH_TEMPLATES[kind];
  const conditions = [...template.conditions, AUTHOR_IN_SCOPE];
  if (template.isExpiring) {
    conditions.push(
      `${template.savedColumn} >= ${bind(scope.expiryCutoff)}::timestamptz`,
    );
  }
  const notice = noticeFor(kind, scope);
  if (notice !== null) {
    conditions.push(`${template.savedColumn} >= ${bind(notice)}::timestamptz`);
  }
  if (scope.draftId !== undefined) {
    conditions.push(
      `"${template.rowAlias}"."id" = ${bind(scope.draftId)}::uuid`,
    );
  }
  const select = [
    `SELECT '${kind}'::text AS "kind"`,
    `"${template.rowAlias}"."id" AS "id"`,
    `${template.ownerColumn} AS "owner_user_id"`,
    `${template.savedColumn} AS "last_saved_at"`,
  ].join(', ');
  const where = ` WHERE ${conditions.join(' AND ')}`;
  const authorJoin = ` JOIN "users" "author" ON "author"."id" = ${template.ownerColumn}`;
  return `${select} FROM ${template.from}${authorJoin}${where}`;
}

/** Builds the joined branches, numbering parameters from `$1`. */
function unionOf(
  scope: CreatorDraftScope,
  parameters: unknown[],
): string | null {
  const bind: BindParameter = (value) => {
    parameters.push(value);
    return `$${parameters.length}`;
  };
  const branches = CREATOR_DRAFT_KINDS.filter(
    (kind) => scope.kinds.includes(kind) && isReadableKind(kind, scope),
  ).map((kind) => branchFor(kind, scope, bind));
  return branches.length > 0 ? branches.join(' UNION ALL ') : null;
}

/** One page of in-scope drafts, newest first. Null when no kind is readable. */
export function buildCreatorDraftPageQuery(
  scope: CreatorDraftScope,
  page: number,
): PositionalQuery | null {
  const parameters: unknown[] = [];
  const union = unionOf(scope, parameters);
  if (union === null) return null;
  parameters.push(PAGE_SIZE);
  const limitPlaceholder = `$${parameters.length}`;
  parameters.push((page - 1) * PAGE_SIZE);
  const offsetPlaceholder = `$${parameters.length}`;
  return {
    sql: `SELECT * FROM (${union}) AS "drafts" ORDER BY "last_saved_at" DESC, "kind" ASC, "id" DESC LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
    parameters,
  };
}

/** The count matching `buildCreatorDraftPageQuery`. Null when no kind is readable. */
export function buildCreatorDraftCountQuery(
  scope: CreatorDraftScope,
): PositionalQuery | null {
  const parameters: unknown[] = [];
  const union = unionOf(scope, parameters);
  if (union === null) return null;
  return {
    sql: `SELECT COUNT(*)::int AS "total" FROM (${union}) AS "drafts"`,
    parameters,
  };
}
