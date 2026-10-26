import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository, SelectQueryBuilder } from 'typeorm';
import { AmbassadorStatusService } from '../ambassadors/ambassador-status.service';
import { escapeLikeTerm } from '../common/like-escape';
import {
  MemberLookup,
  MemberRef,
  toVisibleAvatarUrl,
} from '../common/member-ref';
import { Invite, InviteStatus } from '../membership/entities/invite.entity';
import {
  PublicInviteStatus,
  resolveInviteStatus,
} from '../membership/invite-response';
import { INVITE_TTL_MS } from '../membership/invites.service';
import { resolveMonthlyInviteLimit } from '../membership/monthly-invite-limit';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { RecognitionEntitlementsService } from '../recognition/recognition-entitlements.service';
import { DEFAULT_INVITE_MONTHLY_QUOTA } from '../recognition/recognition.catalog';
import { foldedHaystack, foldedTextExpression } from '../search/search-text';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import {
  AdminInviteBulkSkipDTO,
  AdminInviteDTO,
  AdminInviteInviterDTO,
  AdminInviteQuotaListDTO,
  AdminInviteQuotaMemberDTO,
  AdminInvitesBulkResultDTO,
  AdminInvitesPageDTO,
  AdminInvitesRefreshExpiredResultDTO,
  AdminInviteSkipReason,
  toAdminInviteDTO,
} from './admin-invites-response';
import { AdminInviteBulkAction } from './dto/bulk-admin-invites.dto';
import { ListAdminInviteQuotasQuery } from './dto/list-admin-invite-quotas.query';
import {
  AdminInviteStatusFilter,
  ListAdminInvitesQuery,
} from './dto/list-admin-invites.query';

/** One page of the admin invites list. */
export const ADMIN_INVITES_PAGE_SIZE = 20;

/** One page of the admin invite quotas list. */
export const ADMIN_INVITE_QUOTAS_PAGE_SIZE = 20;

/** What the quotas `q` search matches, each folded for case and accents with
 * the same helpers as the admin member search: first name, last name, full
 * name and slug, each compared on its own. */
const QUOTA_SEARCH_HAYSTACKS = [
  foldedHaystack('profile', ['first_name']),
  foldedHaystack('profile', ['last_name']),
  foldedHaystack('profile', ['first_name', 'last_name']),
  foldedHaystack('profile', ['slug']),
];

/** Start of the current UTC calendar month, the lower bound of "sent this
 * month". The same window as `currentMonthStart` in `invites.service.ts`,
 * which enforcement counts against the limit. */
function currentUtcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** One raw row of the quotas page query. Postgres returns counts as strings. */
interface InviteQuotaRow {
  userId: string;
  slug: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  photoVisible: boolean;
  inviteMonthlyQuota: number | null;
  hasInviteAccess: boolean;
  sentThisMonth: string;
  sentTotal: string;
}

/** Rows per audit insert in `refreshExpired`, keeping one statement well under
 * Postgres's 65535 bind-parameter ceiling (each audit row binds 8). */
const AUDIT_INSERT_CHUNK_SIZE = 1000;

/** WHERE predicate (unaliased columns, for an UPDATE) matching an invite whose
 * RESOLVED status is 'expired': stored `expired`, or `pending` with
 * `expires_at` already passed. Binds `:expired`, `:pending` and `:now`. */
const REFRESHABLE_INVITE_PREDICATE =
  '(status = :expired OR (status = :pending AND expires_at IS NOT NULL AND expires_at <= :now))';

/** WHERE predicate (unaliased columns, for an UPDATE) matching an invite whose
 * RESOLVED status is 'valid': `pending` with no expiry or one still ahead.
 * Binds `:pending` and `:now`. */
const REVOCABLE_INVITE_PREDICATE =
  '(status = :pending AND (expires_at IS NULL OR expires_at > :now))';

/** The one resolved status each admin action applies to. */
const ELIGIBLE_STATUS_BY_ACTION: Record<
  AdminInviteBulkAction,
  PublicInviteStatus
> = {
  revoke: 'valid',
  refresh: 'expired',
};

/** The skip reason that names each resolved status. */
const SKIP_REASON_BY_STATUS: Record<PublicInviteStatus, AdminInviteSkipReason> =
  {
    valid: 'still_valid',
    used: 'accepted',
    revoked: 'revoked',
    expired: 'expired',
  };

/** The 409 message each single route answers with, per skip reason. Each
 * action's own eligible status maps to the generic message, which is only
 * reachable when a lost race re-reads a row that still looks eligible. */
const CONFLICT_MESSAGES: Record<
  AdminInviteBulkAction,
  Record<Exclude<AdminInviteSkipReason, 'not_found'>, string>
> = {
  revoke: {
    accepted:
      'This invite has already been accepted, so there is nothing to revoke.',
    revoked: 'This invite was already revoked.',
    expired: 'This invite has already expired, so there is nothing to revoke.',
    still_valid: 'Only a valid invite can be revoked.',
  },
  refresh: {
    accepted:
      'This invite has already been accepted, so there is nothing to refresh.',
    revoked: 'This invite was revoked, so it stays revoked.',
    still_valid: 'This invite is still active, so there is nothing to refresh.',
    expired: 'Only an expired invite can be refreshed.',
  },
};

/** What applying an admin action to one invite came to. */
type InviteActionOutcome =
  { isUpdated: true } | { isUpdated: false; reason: AdminInviteSkipReason };

/**
 * Read model behind the admin dashboard's platform-wide invite oversight tab:
 * every invite ever minted (personal, approval-minted, or bootstrap), filterable
 * by resolved status / invitee email / a single inviter, newest-first, paginated.
 *
 * Every row is hand-mapped to `AdminInviteDTO` (never a raw entity), and the two
 * member refs per row (inviter + invitee) are resolved in TWO batched profile
 * lookups across the whole page — never one query per row — mirroring
 * `AdminMembersService`'s grouped-query pattern.
 */
@Injectable()
export class AdminInvitesService {
  constructor(
    @InjectRepository(Invite) private readonly invites: Repository<Invite>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly recognitionEntitlements: RecognitionEntitlementsService,
    private readonly ambassadorStatus: AmbassadorStatusService,
  ) {}

  async list(query: ListAdminInvitesQuery): Promise<AdminInvitesPageDTO> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const now = new Date();

    const inviteQueryBuilder = this.invites.createQueryBuilder('invite');

    if (query.status) {
      this.applyStatusFilter(inviteQueryBuilder, query.status, now);
    }
    if (query.inviterId) {
      inviteQueryBuilder.andWhere('invite.inviterId = :inviterId', {
        inviterId: query.inviterId,
      });
    }
    const inviterSlug = query.inviterSlug?.trim();
    if (inviterSlug) {
      // Filter by the sender's slug the admin UI holds, resolved to their
      // userId inline. No status restriction on the join (unlike the active-only
      // `MemberLookup.userIdForSlug`), so filtering matches exactly the rows the
      // list shows — a suspended member's past invites still filter in.
      inviteQueryBuilder.andWhere(
        `invite.inviterId IN ${inviteQueryBuilder
          .subQuery()
          .select('profile.userId')
          .from(Profile, 'profile')
          .where('profile.slug = :inviterSlug')
          .getQuery()}`,
        { inviterSlug },
      );
    }
    const trimmedEmail = query.email?.trim();
    if (trimmedEmail) {
      inviteQueryBuilder.andWhere('invite.email ILIKE :email', {
        email: `%${this.escapeLike(trimmedEmail)}%`,
      });
    }

    inviteQueryBuilder
      .orderBy('invite.createdAt', 'DESC')
      .skip((page - 1) * ADMIN_INVITES_PAGE_SIZE)
      .take(ADMIN_INVITES_PAGE_SIZE);

    const [inviteRows, total] = await inviteQueryBuilder.getManyAndCount();
    if (!inviteRows.length) {
      return { items: [], total, page, pageSize: ADMIN_INVITES_PAGE_SIZE };
    }

    // Resolve inviter + invitee display refs for the whole page in one profile
    // lookup — both sides are userIds, so a single deduped `byUserIds` covers
    // them. `acceptedBy` is null while an invite is unredeemed.
    const memberLookup = new MemberLookup(this.profiles);
    const userIds = [
      ...new Set(
        inviteRows.flatMap((invite) =>
          invite.acceptedBy
            ? [invite.inviterId, invite.acceptedBy]
            : [invite.inviterId],
        ),
      ),
    ];
    const refsByUserId = await memberLookup.byUserIds(userIds);

    const items: AdminInviteDTO[] = inviteRows.map((invite) => {
      const inviter: MemberRef | null =
        refsByUserId.get(invite.inviterId) ?? null;
      const invitee: MemberRef | null = invite.acceptedBy
        ? (refsByUserId.get(invite.acceptedBy) ?? null)
        : null;
      return toAdminInviteDTO(invite, inviter, invitee, now);
    });

    return { items, total, page, pageSize: ADMIN_INVITES_PAGE_SIZE };
  }

  /**
   * Every member who has minted at least one invite, with their invite count,
   * newest lookups deduped to one row per sender and sorted by display name.
   * Powers the admin filter's sender dropdown so it can list every inviter
   * platform-wide (not only those on the pages already loaded). Resolved through
   * the same batched `MemberLookup.byUserIds` the list uses — no status filter,
   * so it matches exactly who can appear as an inviter in the rows.
   *
   * Also batch-fetches each inviter's `inviteMonthlyQuota` override in one
   * extra query (never one per row), so the admin invite-oversight page can
   * show and edit it inline without a second round trip per inviter.
   */
  async listInviters(): Promise<AdminInviteInviterDTO[]> {
    const grouped = await this.invites
      .createQueryBuilder('invite')
      .select('invite.inviterId', 'inviterId')
      .addSelect('COUNT(*)', 'count')
      .groupBy('invite.inviterId')
      .getRawMany<{ inviterId: string; count: string }>();
    if (!grouped.length) return [];

    const inviterIds = grouped.map((row) => row.inviterId);
    const [refsByUserId, quotaRows] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds(inviterIds),
      this.users.find({
        where: { id: In(inviterIds) },
        select: ['id', 'inviteMonthlyQuota'],
      }),
    ]);
    const quotaByUserId = new Map(
      quotaRows.map((userRow) => [userRow.id, userRow.inviteMonthlyQuota]),
    );

    return grouped
      .map((row): AdminInviteInviterDTO | null => {
        const ref = refsByUserId.get(row.inviterId);
        if (!ref) return null;
        return {
          slug: ref.slug,
          name: `${ref.firstName} ${ref.lastName}`.trim(),
          avatarUrl: ref.avatarUrl,
          count: Number(row.count),
          inviteMonthlyQuota: quotaByUserId.get(row.inviterId) ?? null,
        };
      })
      .filter((inviter): inviter is AdminInviteInviterDTO => inviter !== null)
      .sort((first, second) => first.name.localeCompare(second.name));
  }

  /**
   * One page of members with their invite usage and effective monthly limit:
   * `GET /admin/invites/quotas`.
   *
   * Without a search term the set is every member who has sent an invite or
   * holds a quota override. With one it widens to every active member (the
   * same `status = active` rule the admin member search applies), so an admin
   * can set a limit before someone ever invites. Members already in the
   * unfiltered set stay searchable whatever their status, so a search never
   * hides a row the plain list shows. The term matches first name, last name,
   * full name or slug, folded for case and accents like the admin member
   * search (so "Joao" finds "João"), with LIKE wildcards escaped.
   *
   * Two statements for the page and its total, each over one grouped
   * aggregate of `invites` per inviter, so usage is never counted per row.
   * Ordered and paginated in SQL. The limit then goes through
   * `resolveMonthlyInviteLimit` with batched level and ambassador bonuses, one
   * read set for the whole page.
   */
  async listQuotas(
    query: ListAdminInviteQuotasQuery,
  ): Promise<AdminInviteQuotaListDTO> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const defaultMonthlyQuota = this.config.get<number>(
      'app.inviteMonthlyQuota',
      DEFAULT_INVITE_MONTHLY_QUOTA,
    );
    let searchTerm = query.q?.trim() ?? '';
    if (searchTerm.startsWith('@')) {
      searchTerm = searchTerm.slice(1).trim();
    }

    const parameters: unknown[] = [currentUtcMonthStart(new Date())];
    const bind = (value: unknown): string => `$${parameters.push(value)}`;
    const memberSetClauses = [
      '"usage"."inviter_id" IS NOT NULL',
      '"user"."invite_monthly_quota" IS NOT NULL',
    ];
    let searchClause = '';
    if (searchTerm) {
      memberSetClauses.push(`"user"."status" = ${bind(UserStatus.Active)}`);
      const foldedPattern = foldedTextExpression(
        bind(`%${escapeLikeTerm(searchTerm)}%`),
      );
      searchClause = `AND (${QUOTA_SEARCH_HAYSTACKS.map(
        (haystack) => `${haystack} LIKE ${foldedPattern} ESCAPE '\\'`,
      ).join(' OR ')})`;
    }
    const filteredMembersSql = `
      WITH "usage" AS (
        SELECT "inviter_id",
          COUNT(*) FILTER (WHERE "created_at" >= $1) AS "sent_this_month",
          COUNT(*) AS "sent_total"
        FROM "invites"
        GROUP BY "inviter_id"
      )
      SELECT
        "profile"."user_id" AS "userId",
        "profile"."slug" AS "slug",
        "profile"."first_name" AS "firstName",
        "profile"."last_name" AS "lastName",
        "profile"."avatar_url" AS "avatarUrl",
        "profile"."photo_visible" AS "photoVisible",
        "user"."invite_monthly_quota" AS "inviteMonthlyQuota",
        "user"."has_invite_access" AS "hasInviteAccess",
        COALESCE("usage"."sent_this_month", 0) AS "sentThisMonth",
        COALESCE("usage"."sent_total", 0) AS "sentTotal",
        TRIM("profile"."first_name" || ' ' || "profile"."last_name") AS "displayName"
      FROM "profiles" "profile"
      INNER JOIN "users" "user" ON "user"."id" = "profile"."user_id"
      LEFT JOIN "usage" ON "usage"."inviter_id" = "profile"."user_id"
      WHERE (${memberSetClauses.join(' OR ')})
      ${searchClause}`;

    const countParameters = [...parameters];
    const limitParameter = bind(ADMIN_INVITE_QUOTAS_PAGE_SIZE);
    const offsetParameter = bind((page - 1) * ADMIN_INVITE_QUOTAS_PAGE_SIZE);
    const [rows, countRows] = await Promise.all([
      this.dataSource.query<InviteQuotaRow[]>(
        `${filteredMembersSql}
        ORDER BY "sentThisMonth" DESC, "sentTotal" DESC, "displayName" ASC, "userId" ASC
        LIMIT ${limitParameter} OFFSET ${offsetParameter}`,
        parameters,
      ),
      this.dataSource.query<{ total: string }[]>(
        `SELECT COUNT(*) AS "total" FROM (${filteredMembersSql}) "filtered"`,
        countParameters,
      ),
    ]);
    const total = Number(countRows[0]?.total ?? 0);
    if (!rows.length) {
      return {
        defaultMonthlyQuota,
        items: [],
        total,
        page,
        pageSize: ADMIN_INVITE_QUOTAS_PAGE_SIZE,
      };
    }

    // The bonuses only shape the limit of a member without an override.
    const bonusUserIds = rows
      .filter((row) => row.inviteMonthlyQuota == null)
      .map((row) => row.userId);
    const [levelBonusByUserId, ambassadorBonusByUserId] = await Promise.all([
      this.recognitionEntitlements.getInviteQuotaBonusForUserIds(bonusUserIds),
      this.ambassadorStatus.getInviteBonusForUserIds(bonusUserIds),
    ]);

    const items = rows.map((row): AdminInviteQuotaMemberDTO => ({
      slug: row.slug,
      name: `${row.firstName} ${row.lastName}`.trim(),
      avatarUrl: toVisibleAvatarUrl(row),
      sentThisMonth: Number(row.sentThisMonth),
      sentTotal: Number(row.sentTotal),
      inviteMonthlyQuota: row.inviteMonthlyQuota,
      // False while an admin has paused this member's invites.
      hasInviteAccess: row.hasInviteAccess,
      monthlyLimit: resolveMonthlyInviteLimit({
        inviteQuotaOverride: row.inviteMonthlyQuota,
        base: defaultMonthlyQuota,
        levelBonus: levelBonusByUserId.get(row.userId) ?? 0,
        ambassadorBonus: ambassadorBonusByUserId.get(row.userId) ?? 0,
      }),
    }));
    return {
      defaultMonthlyQuota,
      items,
      total,
      page,
      pageSize: ADMIN_INVITE_QUOTAS_PAGE_SIZE,
    };
  }

  /**
   * Revoke any still-valid invite platform-wide — `DELETE /admin/invites/:id`.
   *
   * The member-facing `DELETE /invites/:code` is scoped to `{ code, inviterId }`,
   * so an admin had no way at all to pull someone else's live invite link. This
   * is that missing lever: addressed by the internal `id` the admin list already
   * carries (never the shared `code`), and deliberately NOT scoped to an owner.
   *
   * Semantics, mirroring `InvitesService.revokeInvite`'s guards without its
   * ownership scoping:
   *  - 404 when no invite carries that id;
   *  - 409 when the invite is not revocable, keyed off the RESOLVED status the
   *    admin list shows (`resolveInviteStatus`) rather than the stored column —
   *    a `pending` row past its `expiresAt` reads as 'expired' in the UI and
   *    must answer the same way here, or the drawer would offer an action that
   *    reports a state nobody can see. Already-revoked is a conflict too, not a
   *    silent success: the admin surface only offers this on a valid invite, so
   *    a second call means the row moved underneath them and they should be
   *    told.
   *
   * The flip is a conditional `status = Pending` update (the same single-consume
   * guard `claimInvite` uses), so a redemption racing the revoke cannot both
   * win. The loser re-reads and reports the real terminal state.
   *
   * AUDITED, like every neighbouring admin action that changes another member's
   * standing (`AdminMembersService.updateRole` / `grantStaffRole` /
   * `updateInviteQuota`): a `mod_audit_logs` row with `action =
   * 'invite_revoked'`, the inviter as `targetUserId` + `targetName`, and the
   * invite code in `note`. Written in the SAME transaction as the status flip,
   * so the trail can never disagree with the column.
   */
  async revoke(inviteId: string, actorUserId: string): Promise<AdminInviteDTO> {
    // A revoked invite was never redeemed, so there is no invitee to resolve:
    // `acceptedBy` is null by construction on this path.
    return this.applySingleInviteAction('revoke', inviteId, actorUserId);
  }

  /**
   * Refresh any expired invite platform-wide: `POST /admin/invites/:id/refresh`.
   *
   * The unscoped admin counterpart to the member-side resend
   * (`InvitesService.resendInvite`), which only lets an inviter refresh their
   * OWN expired invites. Addressed by the internal `id` the admin list already
   * carries, the same way `revoke` is, and deliberately unscoped to an owner.
   *
   * The refresh reuses the SAME row: the status flips back to `pending` and
   * `expiresAt` moves to now + `INVITE_TTL_MS`, so the link the inviter already
   * shared keeps working under its original code. `createdAt` is untouched,
   * which keeps it quota-neutral: the inviter's monthly allowance counts mints,
   * and this is the same invitation given more time.
   *
   * Semantics, mirroring `revoke`:
   *  - 404 when no invite carries that id;
   *  - 409 unless the RESOLVED status (`resolveInviteStatus`) is 'expired', so
   *    a lapsed-but-unswept `pending` row qualifies exactly as the admin list
   *    shows it. Accepted, revoked, and still-valid invites each answer with
   *    their own reason.
   *
   * The flip is a conditional update over the resolved-'expired' predicate, so
   * a concurrent revoke, redemption or refresh that lands first makes this call
   * lose cleanly; the loser re-reads and reports the state that actually won.
   *
   * AUDITED like `revoke`: a `mod_audit_logs` row with `action =
   * 'invite_refreshed'`, the inviter as `targetUserId` + `targetName`, and the
   * invite code in `note`, written in the SAME transaction as the update so the
   * trail and the column always agree.
   */
  async refresh(
    inviteId: string,
    actorUserId: string,
  ): Promise<AdminInviteDTO> {
    // Only an expired invite reaches the update, and an expired invite was
    // never redeemed, so `acceptedBy` is null and there is no invitee.
    return this.applySingleInviteAction('refresh', inviteId, actorUserId);
  }

  /**
   * Refresh or revoke many invites at once: `POST /admin/invites/bulk`.
   *
   * Each id goes through `applyInviteAction`, the same path the single routes
   * take, so the eligibility check, the conditional update, the race handling
   * and the audit row are identical per invite. Each invite commits in its own
   * transaction, so one that does not qualify lands in `skipped` with its
   * reason and the others go ahead.
   *
   * Reads are batched: one invite read for every id, one profile lookup for
   * every inviter, and one re-read of the invites that changed. `updated`
   * keeps the order of `ids`.
   *
   * Ids are matched lowercased, since Postgres returns uuids in lowercase and
   * the DTO accepts any casing (like `ParseUUIDPipe` on the single routes).
   * `skipped[].id` echoes each id exactly as the caller sent it. A second
   * spelling of an id already handled in this call is passed over, so each
   * invite is processed once (the DTO's case-insensitive `ArrayUnique` already
   * answers that body with a 400).
   */
  async bulk(
    action: AdminInviteBulkAction,
    ids: string[],
    actorUserId: string,
  ): Promise<AdminInvitesBulkResultDTO> {
    const seenInviteIds = new Set<string>();
    const requestedInvites: { sentId: string; inviteId: string }[] = [];
    for (const sentId of ids) {
      const inviteId = sentId.toLowerCase();
      if (seenInviteIds.has(inviteId)) {
        continue;
      }
      seenInviteIds.add(inviteId);
      requestedInvites.push({ sentId, inviteId });
    }

    const inviteRows = await this.invites.findBy({
      id: In([...seenInviteIds]),
    });
    const invitesById = new Map(
      inviteRows.map((invite) => [invite.id, invite]),
    );
    const refsByUserId = await new MemberLookup(this.profiles).byUserIds([
      ...new Set(inviteRows.map((invite) => invite.inviterId)),
    ]);

    const updatedInvites: { sentId: string; inviteId: string }[] = [];
    const skipped: AdminInviteBulkSkipDTO[] = [];
    for (const requestedInvite of requestedInvites) {
      const invite = invitesById.get(requestedInvite.inviteId) ?? null;
      const inviterRef = invite
        ? (refsByUserId.get(invite.inviterId) ?? null)
        : null;
      const outcome = await this.applyInviteAction(
        action,
        invite,
        inviterRef,
        actorUserId,
      );
      if (outcome.isUpdated) {
        updatedInvites.push(requestedInvite);
      } else {
        skipped.push({
          id: requestedInvite.sentId,
          code: invite?.code ?? null,
          reason: outcome.reason,
        });
      }
    }

    const now = new Date();
    const updatedRows = updatedInvites.length
      ? await this.invites.findBy({
          id: In(updatedInvites.map((updatedInvite) => updatedInvite.inviteId)),
        })
      : [];
    const updatedRowsById = new Map(
      updatedRows.map((invite) => [invite.id, invite]),
    );
    const updated: AdminInviteDTO[] = [];
    for (const { sentId, inviteId } of updatedInvites) {
      const updatedInvite = updatedRowsById.get(inviteId);
      if (!updatedInvite) {
        // Deleted between the update and the re-read.
        skipped.push({ id: sentId, code: null, reason: 'not_found' });
        continue;
      }
      // Revoked and refreshed invites were never redeemed, so neither has an
      // invitee to resolve.
      updated.push(
        toAdminInviteDTO(
          updatedInvite,
          refsByUserId.get(updatedInvite.inviterId) ?? null,
          null,
          now,
        ),
      );
    }
    return { updated, skipped };
  }

  /**
   * Refresh every expired invite at once, optionally only those one member
   * sent: `POST /admin/invites/refresh-expired`.
   *
   * "Expired" is the RESOLVED status, the same predicate the list's 'expired'
   * filter uses (`applyStatusFilter`): stored `expired`, or `pending` with
   * `expires_at` already passed. `inviterSlug` resolves through the same
   * unrestricted profile subquery `list` uses, so an unknown slug matches no
   * rows and refreshes nothing.
   *
   * Set-based: one transaction holding one `UPDATE ... RETURNING` and one
   * batched audit insert (`invite_refreshed`, one row per invite, shaped like
   * the single refresh's). Quota-neutral like the single refresh, since
   * `createdAt` is untouched. The update re-checks the predicate per row, so a
   * revoke or redemption landing first simply leaves that row out.
   */
  async refreshExpired(
    actorUserId: string,
    inviterSlug: string | undefined,
  ): Promise<AdminInvitesRefreshExpiredResultDTO> {
    const now = new Date();
    const trimmedInviterSlug = inviterSlug?.trim();

    return this.dataSource.transaction(async (manager) => {
      const updateQueryBuilder = manager
        .createQueryBuilder()
        .update(Invite)
        .set({
          status: InviteStatus.Pending,
          expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
        })
        .where(REFRESHABLE_INVITE_PREDICATE, {
          expired: InviteStatus.Expired,
          pending: InviteStatus.Pending,
          now,
        });
      if (trimmedInviterSlug) {
        const profileTableName =
          manager.getRepository(Profile).metadata.tableName;
        updateQueryBuilder.andWhere(
          `inviter_id IN (SELECT user_id FROM "${profileTableName}" WHERE slug = :inviterSlug)`,
          { inviterSlug: trimmedInviterSlug },
        );
      }
      const result = await updateQueryBuilder
        .returning('id, code, inviter_id')
        .execute();
      const refreshedRows = (result.raw ?? []) as {
        id: string;
        code: string;
        inviter_id: string;
      }[];
      if (!refreshedRows.length) {
        return { refreshedCount: 0 };
      }

      const refsByUserId = await new MemberLookup(
        manager.getRepository(Profile),
      ).byUserIds([...new Set(refreshedRows.map((row) => row.inviter_id))]);
      const auditRows = refreshedRows.map((row) =>
        this.toInviteAuditRow(
          'refresh',
          actorUserId,
          row.inviter_id,
          row.code,
          refsByUserId.get(row.inviter_id) ?? null,
        ),
      );
      const auditLogs = manager.getRepository(ModAuditLog);
      for (
        let chunkStart = 0;
        chunkStart < auditRows.length;
        chunkStart += AUDIT_INSERT_CHUNK_SIZE
      ) {
        await auditLogs.insert(
          auditRows.slice(chunkStart, chunkStart + AUDIT_INSERT_CHUNK_SIZE),
        );
      }
      return { refreshedCount: refreshedRows.length };
    });
  }

  /**
   * One invite through a single route: read it, apply the shared path, and turn
   * a skip reason into the route's 404 or 409, then return the updated row.
   */
  private async applySingleInviteAction(
    action: AdminInviteBulkAction,
    inviteId: string,
    actorUserId: string,
  ): Promise<AdminInviteDTO> {
    const now = new Date();
    const invite = await this.invites.findOne({ where: { id: inviteId } });
    const inviterRef = invite
      ? ((
          await new MemberLookup(this.profiles).byUserIds([invite.inviterId])
        ).get(invite.inviterId) ?? null)
      : null;

    const outcome = await this.applyInviteAction(
      action,
      invite,
      inviterRef,
      actorUserId,
    );
    if (!outcome.isUpdated) {
      if (outcome.reason === 'not_found') {
        throw new NotFoundException('Invite not found');
      }
      throw new ConflictException(CONFLICT_MESSAGES[action][outcome.reason]);
    }

    const updatedInvite = await this.invites.findOne({
      where: { id: inviteId },
    });
    if (!updatedInvite) {
      throw new NotFoundException('Invite not found');
    }
    return toAdminInviteDTO(updatedInvite, inviterRef, null, now);
  }

  /**
   * The one path both the single routes and the bulk route take for a single
   * invite. Checks the RESOLVED status (`resolveInviteStatus`) so a
   * lapsed-but-unswept `pending` row reads as expired, exactly as the admin
   * list renders it, then runs the action's conditional update and its audit
   * row in one transaction. When the conditional update loses a race (it
   * affected no row), the invite is re-read and the state that won is
   * reported as the skip reason.
   *
   * The update's WHERE carries the same resolved-status predicate as the
   * pre-check, evaluated at a `now` taken inside the transaction. A bulk call
   * runs up to `ADMIN_INVITE_BULK_CAP` of these one after another, so an invite
   * another admin refreshed a moment ago (now valid again) is left alone, and a
   * pending invite that lapsed while the loop ran is reported as expired.
   */
  private async applyInviteAction(
    action: AdminInviteBulkAction,
    invite: Invite | null,
    inviterRef: MemberRef | null,
    actorUserId: string,
  ): Promise<InviteActionOutcome> {
    if (!invite) {
      return { isUpdated: false, reason: 'not_found' };
    }
    const resolvedStatus = resolveInviteStatus(invite, new Date());
    if (resolvedStatus !== ELIGIBLE_STATUS_BY_ACTION[action]) {
      return {
        isUpdated: false,
        reason: SKIP_REASON_BY_STATUS[resolvedStatus],
      };
    }

    return this.dataSource.transaction(
      async (manager): Promise<InviteActionOutcome> => {
        const transactionNow = new Date();
        const updateQueryBuilder = manager.createQueryBuilder().update(Invite);
        const result =
          action === 'revoke'
            ? await updateQueryBuilder
                .set({ status: InviteStatus.Revoked })
                .where('id = :inviteId', { inviteId: invite.id })
                .andWhere(REVOCABLE_INVITE_PREDICATE, {
                  pending: InviteStatus.Pending,
                  now: transactionNow,
                })
                .execute()
            : await updateQueryBuilder
                .set({
                  status: InviteStatus.Pending,
                  expiresAt: new Date(transactionNow.getTime() + INVITE_TTL_MS),
                })
                .where('id = :inviteId', { inviteId: invite.id })
                .andWhere(REFRESHABLE_INVITE_PREDICATE, {
                  expired: InviteStatus.Expired,
                  pending: InviteStatus.Pending,
                  now: transactionNow,
                })
                .execute();
        if (result.affected !== 1) {
          // Lost a race with a redemption, the expiry sweeper, a concurrent
          // revoke or refresh, or the invite's own expiry. Re-read and report
          // the state that actually won.
          const current = await manager.findOne(Invite, {
            where: { id: invite.id },
          });
          if (!current) {
            return { isUpdated: false, reason: 'not_found' };
          }
          return {
            isUpdated: false,
            reason:
              SKIP_REASON_BY_STATUS[resolveInviteStatus(current, new Date())],
          };
        }

        const auditLogs = manager.getRepository(ModAuditLog);
        await auditLogs.save(
          auditLogs.create(
            this.toInviteAuditRow(
              action,
              actorUserId,
              invite.inviterId,
              invite.code,
              inviterRef,
            ),
          ),
        );
        return { isUpdated: true };
      },
    );
  }

  /** The audit row an admin revoke or refresh writes: the inviter as
   *  `targetUserId` + `targetName`, and the invite code in `note`. */
  private toInviteAuditRow(
    action: AdminInviteBulkAction,
    actorUserId: string,
    inviterId: string,
    inviteCode: string,
    inviterRef: MemberRef | null,
  ): Partial<ModAuditLog> {
    return {
      reportId: null,
      actorId: actorUserId,
      targetUserId: inviterId,
      targetName: inviterRef
        ? `${inviterRef.firstName} ${inviterRef.lastName}`.trim()
        : null,
      action: action === 'revoke' ? 'invite_revoked' : 'invite_refreshed',
      reasonCode: null,
      note: inviteCode,
      duration: null,
    };
  }

  /**
   * Translate the resolved-status filter the admin picked into SQL, so the
   * paginated `total` matches exactly the rows shown. 'expired' and 'valid' both
   * have to reach into `expires_at` because a still-`pending` row past its
   * expiry resolves as 'expired' but is only stored 'expired' once swept.
   */
  private applyStatusFilter(
    inviteQueryBuilder: SelectQueryBuilder<Invite>,
    status: AdminInviteStatusFilter,
    now: Date,
  ): void {
    switch (status) {
      case 'used':
        inviteQueryBuilder.andWhere('invite.status = :accepted', {
          accepted: InviteStatus.Accepted,
        });
        break;
      case 'revoked':
        inviteQueryBuilder.andWhere('invite.status = :revoked', {
          revoked: InviteStatus.Revoked,
        });
        break;
      case 'expired':
        inviteQueryBuilder.andWhere(
          '(invite.status = :expired OR (invite.status = :pending AND invite.expiresAt IS NOT NULL AND invite.expiresAt <= :now))',
          { expired: InviteStatus.Expired, pending: InviteStatus.Pending, now },
        );
        break;
      case 'valid':
        inviteQueryBuilder.andWhere(
          '(invite.status = :pending AND (invite.expiresAt IS NULL OR invite.expiresAt > :now))',
          { pending: InviteStatus.Pending, now },
        );
        break;
    }
  }

  /** Escape LIKE/ILIKE wildcards so an admin's literal search text can't be
   *  read as a pattern (a `%` in the box means the character, not "any run"). */
  private escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (match) => `\\${match}`);
  }
}
