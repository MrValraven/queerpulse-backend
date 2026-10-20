import { ConfigService } from '@nestjs/config';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { DEFAULT_CREATOR_DRAFT_RETENTION_DAYS } from '../creator-drafts/creator-drafts.constants';
import { CreatorDraft } from '../creator-drafts/entities/creator-draft.entity';
import { NEW_DOMAIN_EXPORT_CONTRIBUTORS } from './data-export-contributors';
import { CreatorDraftsExportContributor } from './data-export-contributors-creator-drafts';
import { EXPORT_CSV_CATEGORIES } from './export-archive';

const LISTING_ID = '75000000-0000-4000-8000-000000000001';
const CREATED = new Date('2026-09-01T10:00:00.000Z');
const UPDATED = new Date('2026-10-01T10:00:00.000Z');

describe('CreatorDraftsExportContributor', () => {
  let drafts: { find: jest.Mock };
  let config: { get: jest.Mock };
  let contributor: CreatorDraftsExportContributor;

  beforeEach(() => {
    drafts = { find: jest.fn() };
    config = { get: jest.fn().mockReturnValue(90) };
    contributor = new CreatorDraftsExportContributor(
      drafts as unknown as Repository<CreatorDraft>,
      config as unknown as ConfigService,
    );
  });

  it('falls back to the shared default retention window', async () => {
    drafts.find.mockResolvedValue([]);
    await contributor.buildContribution('member-1');
    expect(config.get).toHaveBeenCalledWith(
      'retention.creatorDraftDays',
      DEFAULT_CREATOR_DRAFT_RETENTION_DAYS,
    );
  });

  it('exports every live draft of the member, oldest first, with the listing id for a listing edit', async () => {
    drafts.find.mockResolvedValue([
      {
        kind: 'listing_edit',
        slotKey: LISTING_ID,
        payload: { draft: { name: 'Café Arco' } },
        payloadVersion: 1,
        revision: 3,
        createdAt: CREATED,
        updatedAt: UPDATED,
      },
      {
        kind: 'event',
        slotKey: '',
        payload: { title: 'Swap' },
        payloadVersion: 1,
        revision: 1,
        createdAt: CREATED,
        updatedAt: UPDATED,
      },
    ]);
    await expect(contributor.buildContribution('member-1')).resolves.toEqual([
      {
        kind: 'listing_edit',
        listingId: LISTING_ID,
        payload: { draft: { name: 'Café Arco' } },
        payloadVersion: 1,
        revision: 3,
        createdAt: CREATED.toISOString(),
        updatedAt: UPDATED.toISOString(),
      },
      {
        kind: 'event',
        listingId: null,
        payload: { title: 'Swap' },
        payloadVersion: 1,
        revision: 1,
        createdAt: CREATED.toISOString(),
        updatedAt: UPDATED.toISOString(),
      },
    ]);
    expect(drafts.find).toHaveBeenCalledWith({
      where: {
        userId: 'member-1',
        updatedAt: MoreThanOrEqual(expect.any(Date) as Date),
      },
      order: { createdAt: 'ASC' },
    });
  });

  it('rides on the saved category under the creatorDrafts key', () => {
    expect(contributor.category).toBe('saved');
    expect(contributor.archiveKey).toBe('creatorDrafts');
  });

  it('registers the contributor and its csv key in the same place in both lists', () => {
    const keys = NEW_DOMAIN_EXPORT_CONTRIBUTORS.map(
      (registered) => registered.name,
    );
    expect(keys.indexOf('CreatorDraftsExportContributor')).toBe(
      keys.indexOf('StudioCopyrightClaimsExportContributor') + 1,
    );
    const csvKeys: readonly string[] = EXPORT_CSV_CATEGORIES;
    expect(csvKeys.indexOf('creatorDrafts')).toBe(
      csvKeys.indexOf('studioCopyrightClaims') + 1,
    );
  });
});
