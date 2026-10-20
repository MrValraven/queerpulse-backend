import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  MAX_PAGE,
  normalizePage,
  PAGE_SIZE,
  Paginated,
} from '../common/pagination';
import { ModAuditService } from '../moderation/mod-audit.service';
import {
  buildCreatorDraftCountQuery,
  buildCreatorDraftPageQuery,
  CreatorDraftScope,
  CreatorDraftUnionRow,
  enabledCreatorDraftKinds,
} from './admin-creator-draft-union';
import { AdminCreatorDraftRowsService } from './admin-creator-draft-rows.service';
import { recordCreatorDraftViewed } from './creator-draft-audit';
import { creatorDraftExpiryCutoff } from './creator-draft-store';
import type {
  AdminCreatorDraftDetail,
  AdminCreatorDraftRow,
} from './creator-draft.types';
import {
  CREATOR_DRAFT_VISIBILITY,
  creatorDraftError,
  CreatorDraftKind,
  CreatorDraftVisibility,
  DEFAULT_CREATOR_DRAFT_RETENTION_DAYS,
} from './creator-drafts.constants';
import { ListAdminCreatorDraftsQuery } from './dto/list-admin-creator-drafts.query';

/**
 * The Admin read over every open creator draft. The scope (notice dates,
 * expiry, feature switches, out-of-scope authors and personas) lives in the
 * union builders; this service picks the enabled kinds, runs the SQL and
 * hands the ids to `AdminCreatorDraftRowsService` for hydration.
 *
 * Read-only. Each detail read writes exactly one `creator_draft_viewed` row
 * after the response is built; when that write fails the request fails and
 * shows nothing. The list writes no audit row. No title, name or payload
 * reaches a log line or an error message here.
 */
@Injectable()
export class AdminCreatorDraftsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly rows: AdminCreatorDraftRowsService,
    private readonly modAudit: ModAuditService,
    private readonly config: ConfigService,
    @Inject(CREATOR_DRAFT_VISIBILITY)
    private readonly visibility: CreatorDraftVisibility,
  ) {}

  /** `GET /admin/creator-drafts`: newest saved first, one page of 20. */
  async list(
    query: ListAdminCreatorDraftsQuery,
  ): Promise<Paginated<AdminCreatorDraftRow>> {
    const page = Math.min(normalizePage(query.page), MAX_PAGE);
    const empty: Paginated<AdminCreatorDraftRow> = {
      items: [],
      total: 0,
      page,
      pageSize: PAGE_SIZE,
    };
    const kinds = enabledCreatorDraftKinds(query.kind, this.visibility);
    if (kinds.length === 0) return empty;

    const scope = this.scopeFor(kinds);
    const pageQuery = buildCreatorDraftPageQuery(scope, page);
    const countQuery = buildCreatorDraftCountQuery(scope);
    if (pageQuery === null || countQuery === null) return empty;

    const [unionRows, countRows] = await Promise.all([
      this.dataSource.query<CreatorDraftUnionRow[]>(
        pageQuery.sql,
        pageQuery.parameters,
      ),
      this.dataSource.query<{ total: number | string }[]>(
        countQuery.sql,
        countQuery.parameters,
      ),
    ]);
    const items =
      unionRows.length > 0 ? await this.rows.rowsFor(unionRows) : [];
    return {
      items,
      total: Number(countRows[0]?.total ?? 0),
      page,
      pageSize: PAGE_SIZE,
    };
  }

  /**
   * `GET /admin/creator-drafts/:kind/:id`. Any miss (kind gated, out of
   * scope, expired, gone between reads, or a preview that cannot be built)
   * answers 404 `creator_draft_not_found` and writes nothing.
   */
  async getOne(
    actorId: string,
    kind: CreatorDraftKind,
    id: string,
  ): Promise<AdminCreatorDraftDetail> {
    const kinds = enabledCreatorDraftKinds(kind, this.visibility);
    if (!kinds.includes(kind)) {
      throw creatorDraftError('creator_draft_not_found');
    }
    const pageQuery = buildCreatorDraftPageQuery(this.scopeFor([kind], id), 1);
    if (pageQuery === null) throw creatorDraftError('creator_draft_not_found');

    const unionRows = await this.dataSource.query<CreatorDraftUnionRow[]>(
      pageQuery.sql,
      pageQuery.parameters,
    );
    if (unionRows.length !== 1) {
      throw creatorDraftError('creator_draft_not_found');
    }
    const [row] = await this.rows.rowsFor(unionRows);
    if (row === undefined) throw creatorDraftError('creator_draft_not_found');
    const detail = await this.rows.detailFor(row);
    if (detail === null) throw creatorDraftError('creator_draft_not_found');

    await recordCreatorDraftViewed(
      this.modAudit,
      actorId,
      kind,
      id,
      'creator_drafts',
    );
    return detail;
  }

  private scopeFor(
    kinds: readonly CreatorDraftKind[],
    draftId?: string,
  ): CreatorDraftScope {
    const retentionDays = this.config.get<number>(
      'retention.creatorDraftDays',
      DEFAULT_CREATOR_DRAFT_RETENTION_DAYS,
    );
    return {
      kinds,
      noticeLiveSince: this.visibility.noticeLiveSince,
      expiryCutoff: creatorDraftExpiryCutoff(new Date(), retentionDays),
      ...(draftId === undefined ? {} : { draftId }),
    };
  }
}
