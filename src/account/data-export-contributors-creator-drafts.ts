import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { creatorDraftExpiryCutoff } from '../creator-drafts/creator-draft-store';
import { CreatorDraft } from '../creator-drafts/entities/creator-draft.entity';
import {
  DEFAULT_CREATOR_DRAFT_RETENTION_DAYS,
  type StoredCreatorDraftKind,
} from '../creator-drafts/creator-drafts.constants';
import { DataExportContribution } from './data-export-contributor';

export interface CreatorDraftExportRow {
  kind: StoredCreatorDraftKind;
  listingId: string | null;
  payload: Record<string, unknown>;
  payloadVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * `saved` -> `creatorDrafts`: the member's own event, listing edit and
 * community wizard drafts, oldest first. A listing edit carries its listing id
 * (the slot key); the other kinds carry null. A draft past the retention
 * window is already absent for every reader, so it stays out of the archive.
 */
@Injectable()
export class CreatorDraftsExportContributor implements DataExportContribution {
  readonly category = 'saved';
  readonly archiveKey = 'creatorDrafts';

  constructor(
    @InjectRepository(CreatorDraft)
    private readonly drafts: Repository<CreatorDraft>,
    private readonly config: ConfigService,
  ) {}

  async buildContribution(userId: string): Promise<CreatorDraftExportRow[]> {
    const retentionDays = this.config.get<number>(
      'retention.creatorDraftDays',
      DEFAULT_CREATOR_DRAFT_RETENTION_DAYS,
    );
    const oldestLiveUpdate = creatorDraftExpiryCutoff(
      new Date(),
      retentionDays,
    );
    const rows = await this.drafts.find({
      where: { userId, updatedAt: MoreThanOrEqual(oldestLiveUpdate) },
      order: { createdAt: 'ASC' },
    });
    return rows.map((row) => ({
      kind: row.kind,
      listingId: row.kind === 'listing_edit' ? row.slotKey : null,
      payload: row.payload,
      payloadVersion: row.payloadVersion,
      revision: row.revision,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }
}
