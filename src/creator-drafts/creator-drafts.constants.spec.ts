import { NotFoundException } from '@nestjs/common';
import {
  CREATOR_DRAFT_KIND_FEATURE,
  CREATOR_DRAFT_KIND_VALUES,
  CREATOR_DRAFT_KINDS,
  CREATOR_DRAFT_LIMITS,
  CREATOR_DRAFT_NOTICE_LIVE_SINCE,
  creatorDraftError,
  creatorDraftRevisionConflict,
  DEFAULT_CREATOR_DRAFT_RETENTION_DAYS,
  LISTING_WIZARD_TOTAL_STEPS,
  STORED_CREATOR_DRAFT_KINDS,
} from './creator-drafts.constants';

describe('creator draft vocabulary', () => {
  it('names the seven kinds in wire order and the three stored ones', () => {
    expect(CREATOR_DRAFT_KINDS).toEqual([
      'persona',
      'studio_release',
      'studio_episode',
      'listing',
      'event',
      'listing_edit',
      'community',
    ]);
    expect(STORED_CREATOR_DRAFT_KINDS).toEqual([
      'event',
      'listing_edit',
      'community',
    ]);
    expect(Object.values(CREATOR_DRAFT_KIND_VALUES)).toEqual([
      ...CREATOR_DRAFT_KINDS,
    ]);
  });

  it('dates the stored kinds from the table launch, holds the rest for the deploy, and gives studio kinds one date', () => {
    expect(Object.keys(CREATOR_DRAFT_NOTICE_LIVE_SINCE).sort()).toEqual([
      'community',
      'event',
      'listing_edit',
      'persona',
      'studio_episode',
      'studio_release',
    ]);
    expect(CREATOR_DRAFT_NOTICE_LIVE_SINCE).toEqual({
      persona: null,
      studio_release: null,
      studio_episode: null,
      event: '2026-10-19T00:00:00Z',
      listing_edit: '2026-10-19T00:00:00Z',
      community: '2026-10-19T00:00:00Z',
    });
    expect(CREATOR_DRAFT_NOTICE_LIVE_SINCE.studio_release).toBe(
      CREATOR_DRAFT_NOTICE_LIVE_SINCE.studio_episode,
    );
  });

  it('maps each kind to the feature that gates it', () => {
    expect(CREATOR_DRAFT_KIND_FEATURE).toEqual({
      persona: null,
      studio_release: 'studio',
      studio_episode: 'studio',
      listing: 'listings',
      listing_edit: 'listings',
      event: 'events',
      community: 'communities',
    });
  });

  it('caps the payload at 96 KiB and the wizard at six steps', () => {
    expect(CREATOR_DRAFT_LIMITS.payloadMaxBytes).toBe(96 * 1024);
    expect(LISTING_WIZARD_TOTAL_STEPS).toBe(6);
    expect(DEFAULT_CREATOR_DRAFT_RETENTION_DAYS).toBe(90);
  });

  it('builds coded refusals with the status each code carries', () => {
    expect(creatorDraftError('creator_draft_not_found')).toBeInstanceOf(
      NotFoundException,
    );
    expect(
      creatorDraftError('creator_draft_listing_unavailable').getStatus(),
    ).toBe(404);
    expect(creatorDraftError('creator_draft_too_large').getStatus()).toBe(413);
    expect(creatorDraftError('creator_draft_not_found').getResponse()).toEqual({
      code: 'creator_draft_not_found',
      message: expect.any(String) as string,
    });
  });

  it('carries the current revision and saved time on a conflict, null for an empty slot', () => {
    const filled = creatorDraftRevisionConflict({
      revision: 4,
      savedAt: '2026-10-19T10:00:00.000Z',
    });
    expect(filled.getStatus()).toBe(409);
    expect(filled.getResponse()).toEqual(
      expect.objectContaining({
        code: 'creator_draft_revision_conflict',
        revision: 4,
        savedAt: '2026-10-19T10:00:00.000Z',
      }),
    );
    expect(
      creatorDraftRevisionConflict({
        revision: null,
        savedAt: null,
      }).getResponse(),
    ).toEqual(expect.objectContaining({ revision: null, savedAt: null }));
  });
});
