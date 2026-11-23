import { FindOperator, In } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { HandleOwnerKind } from '../handles/entities/handle.entity';
import { BlockFilterService } from '../social/block-filter.service';
import {
  Subprofile,
  SubprofileLinkVisibility,
} from './entities/subprofile.entity';
import { memberShownOnPeopleListSql } from './persona-creator-gates';
import { SubprofileCreditGraphService } from './subprofile-credit-graph.service';
import type { CreditSubject } from './subprofile-credit-graph';
import {
  VISIBLE_SECTIONS_BY_KIND_JSON,
  VISIBLE_SECTIONS_PARAMETER,
  visibleSectionSql,
} from './subprofile-visible-sections-sql';

// Stubs the fluent `createQueryBuilder('item')` chain each credited-item scan
// builds. Every chained method returns the builder; `getMany` answers with
// the rows the test set for that scan.
interface ItemScanStub {
  select: jest.Mock;
  innerJoin: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  limit: jest.Mock;
  getMany: jest.Mock;
}

function makeItemScanStub(): ItemScanStub {
  const scan = {} as ItemScanStub;
  for (const method of [
    'select',
    'innerJoin',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'limit',
  ] as const) {
    scan[method] = jest.fn().mockReturnValue(scan);
  }
  scan.getMany = jest.fn().mockResolvedValue([]);
  return scan;
}

const INBOUND_CLAUSE = 'item.collaborators && :handles::text[]';

type WhereCall = [string, Record<string, unknown>?];

/** Every WHERE clause one scan was given, in order. */
function whereCalls(scan: ItemScanStub): WhereCall[] {
  return [
    ...(scan.where.mock.calls as WhereCall[]),
    ...(scan.andWhere.mock.calls as WhereCall[]),
  ];
}

function isInboundScan(scan: ItemScanStub): boolean {
  return whereCalls(scan).some((call) => call[0] === INBOUND_CLAUSE);
}

const linkedSubject: CreditSubject = {
  id: 'sp-linked',
  userId: 'creator-1',
  handle: null,
  linkVisibility: SubprofileLinkVisibility.Linked,
};

const unlinkedSubject: CreditSubject = {
  id: 'sp-unlinked',
  userId: 'creator-2',
  handle: 'Nightform',
  linkVisibility: SubprofileLinkVisibility.Unlinked,
};

describe('SubprofileCreditGraphService.loadCardCreditsFor', () => {
  let scans: ItemScanStub[];
  let outboundRows: unknown[];
  let inboundRows: unknown[];
  let items: { createQueryBuilder: jest.Mock };
  let subprofiles: { find: jest.Mock };
  let profiles: { find: jest.Mock };
  let handleRegistry: { find: jest.Mock };
  let members: { find: jest.Mock };
  let contentModeration: { statesFor: jest.Mock };
  let blockFilter: { blockedUserIds: jest.Mock };
  let service: SubprofileCreditGraphService;

  beforeEach(() => {
    scans = [];
    outboundRows = [];
    inboundRows = [];
    items = {
      createQueryBuilder: jest.fn(() => {
        const scan = makeItemScanStub();
        // Each scan answers once its own WHERE clauses are known.
        scan.getMany.mockImplementation(() =>
          Promise.resolve(isInboundScan(scan) ? inboundRows : outboundRows),
        );
        scans.push(scan);
        return scan;
      }),
    };
    subprofiles = { find: jest.fn().mockResolvedValue([]) };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    handleRegistry = { find: jest.fn().mockResolvedValue([]) };
    members = { find: jest.fn().mockResolvedValue([]) };
    contentModeration = { statesFor: jest.fn().mockResolvedValue(new Map()) };
    blockFilter = { blockedUserIds: jest.fn().mockResolvedValue(new Set()) };
    service = new SubprofileCreditGraphService(
      items as never,
      subprofiles as never,
      profiles as never,
      handleRegistry as never,
      members as never,
      contentModeration as unknown as ContentModerationService,
      blockFilter as unknown as BlockFilterService,
    );
  });

  it('stops after the item scans when the page carries no credited items', async () => {
    const credits = await service.loadCardCreditsFor(
      [linkedSubject, unlinkedSubject],
      'viewer-1',
    );

    expect(items.createQueryBuilder).toHaveBeenCalledTimes(2);
    expect(handleRegistry.find).not.toHaveBeenCalled();
    expect(subprofiles.find).not.toHaveBeenCalled();
    expect(profiles.find).not.toHaveBeenCalled();
    expect(members.find).not.toHaveBeenCalled();
    expect(contentModeration.statesFor).not.toHaveBeenCalled();
    expect(blockFilter.blockedUserIds).not.toHaveBeenCalled();
    expect(credits.get('sp-linked')).toEqual({ count: 0, faces: [] });
    expect(credits.get('sp-unlinked')).toEqual({ count: 0, faces: [] });
  });

  it('binds the inbound handles as ONE array parameter and scans outbound by subject id', async () => {
    await service.loadCardCreditsFor(
      [linkedSubject, unlinkedSubject],
      'viewer-1',
    );

    const inboundScan = scans.find(isInboundScan);
    const outboundScan = scans.find((scan) => !isInboundScan(scan));
    expect(inboundScan).toBeDefined();
    const inboundCall = whereCalls(inboundScan!).find(
      (call) => call[0] === INBOUND_CLAUSE,
    );
    // Only the unlinked row's handle, normalized, as a real array.
    expect(Array.isArray(inboundCall?.[1]?.handles)).toBe(true);
    expect(inboundCall?.[1]?.handles).toEqual(['nightform']);
    expect(outboundScan!.where).toHaveBeenCalledWith(
      'item.subprofileId IN (:...subjectIds)',
      { subjectIds: ['sp-linked', 'sp-unlinked'] },
    );
    // Both scans use the partial-index predicate.
    for (const scan of scans) {
      expect(whereCalls(scan)).toContainEqual(["item.collaborators <> '{}'"]);
    }
  });

  it('joins every scanned item to its author and keeps sections the author kind shows', async () => {
    await service.loadCardCreditsFor(
      [linkedSubject, unlinkedSubject],
      'viewer-1',
    );

    expect(scans).toHaveLength(2);
    for (const scan of scans) {
      expect(scan.innerJoin).toHaveBeenCalledWith(
        Subprofile,
        'author',
        'author.id = item.subprofileId',
      );
      expect(scan.andWhere).toHaveBeenCalledWith(
        visibleSectionSql('"item"."section"', '"author"."kind"'),
        { [VISIBLE_SECTIONS_PARAMETER]: VISIBLE_SECTIONS_BY_KIND_JSON },
      );
    }
  });

  it('skips the inbound scan when the page has no unlinked handle', async () => {
    await service.loadCardCreditsFor([linkedSubject], 'viewer-1');

    expect(items.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(scans.some(isInboundScan)).toBe(false);
  });

  it("excludes a co-owner's member credit on a linked subject, loading rosters for the page's subject ids", async () => {
    outboundRows = [
      {
        id: 'item-1',
        subprofileId: 'sp-linked',
        collaborators: ['coowner', 'ana'],
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
      },
    ];
    handleRegistry.find.mockResolvedValue([
      {
        name: 'coowner',
        ownerKind: HandleOwnerKind.Profile,
        userId: 'co-owner-1',
        subprofileId: null,
      },
      {
        name: 'ana',
        ownerKind: HandleOwnerKind.Profile,
        userId: 'ana-user',
        subprofileId: null,
      },
    ]);
    profiles.find.mockResolvedValue([
      {
        userId: 'co-owner-1',
        firstName: 'Cora',
        lastName: 'Owner',
        avatarUrl: null,
        photoVisible: true,
      },
      {
        userId: 'ana-user',
        firstName: 'Ana',
        lastName: 'Reis',
        avatarUrl: null,
        photoVisible: true,
      },
    ]);
    members.find.mockResolvedValue([
      { subprofileId: 'sp-linked', userId: 'co-owner-1' },
    ]);

    const credits = await service.loadCardCreditsFor(
      [linkedSubject, unlinkedSubject],
      'viewer-1',
    );

    expect(members.find).toHaveBeenCalledTimes(1);
    expect(members.find).toHaveBeenCalledWith({
      where: { subprofileId: In(['sp-linked', 'sp-unlinked']) },
      select: { subprofileId: true, userId: true },
    });
    expect(credits.get('sp-linked')).toEqual({
      count: 1,
      faces: [
        { kind: 'member', name: 'Ana Reis', avatarUrl: null, accent: null },
      ],
    });
    expect(credits.get('sp-unlinked')).toEqual({ count: 0, faces: [] });
  });

  // SEC-21: a paused, suspended, erasure-pending or 24-hour-hidden member
  // never loads, so no card or credit names them.
  it('loads credited members only while the people lists would show them', async () => {
    outboundRows = [
      {
        id: 'item-1',
        subprofileId: 'sp-linked',
        collaborators: ['ana'],
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
      },
    ];
    handleRegistry.find.mockResolvedValue([
      {
        name: 'ana',
        ownerKind: HandleOwnerKind.Profile,
        userId: 'ana-user',
        subprofileId: null,
      },
    ]);

    const credits = await service.loadCardCreditsFor(
      [linkedSubject],
      'viewer-1',
    );

    expect(profiles.find).toHaveBeenCalledTimes(1);
    const profileWhere = (
      profiles.find.mock.calls[0] as [{ where: { userId: unknown } }]
    )[0].where;
    expect(profileWhere.userId).toBeInstanceOf(FindOperator);
    const userIdOperator = profileWhere.userId as FindOperator<string>;
    expect(Object.values(userIdOperator.objectLiteralParameters ?? {})).toEqual(
      [['ana-user']],
    );
    expect(userIdOperator.getSql?.('Profile.userId')).toContain(
      memberShownOnPeopleListSql('(Profile.userId)'),
    );
    expect(credits.get('sp-linked')).toEqual({ count: 0, faces: [] });
  });

  // SEC-33: a persona whose creator is not active never loads as a face.
  it('loads credited personas only with an active creator', async () => {
    outboundRows = [
      {
        id: 'item-1',
        subprofileId: 'sp-linked',
        collaborators: ['ember'],
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
      },
    ];
    handleRegistry.find.mockResolvedValue([
      {
        name: 'ember',
        ownerKind: HandleOwnerKind.Subprofile,
        userId: null,
        subprofileId: 'sp-ember',
      },
    ]);

    await service.loadCardCreditsFor([linkedSubject], 'viewer-1');

    expect(subprofiles.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: In(['sp-ember']), user: { status: 'active' } },
      }),
    );
  });

  // SEC-02: a credit of an unlinked persona stays whoever the viewer blocked,
  // so a vanished credit cannot test who runs it.
  it("keeps an unlinked persona's credit when the viewer and its creator are blocked", async () => {
    outboundRows = [
      {
        id: 'item-1',
        subprofileId: 'sp-linked',
        collaborators: ['ember'],
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
      },
    ];
    handleRegistry.find.mockResolvedValue([
      {
        name: 'ember',
        ownerKind: HandleOwnerKind.Subprofile,
        userId: null,
        subprofileId: 'sp-ember',
      },
    ]);
    subprofiles.find.mockResolvedValue([
      {
        id: 'sp-ember',
        handle: 'ember',
        displayName: 'Ember',
        avatarUrl: null,
        accent: null,
        kind: 'dj',
        status: 'published',
        visibility: 'open',
        linkVisibility: SubprofileLinkVisibility.Unlinked,
        removedAt: null,
        userId: 'ember-creator',
      },
    ]);
    blockFilter.blockedUserIds.mockResolvedValue(new Set(['ember-creator']));

    const credits = await service.loadCardCreditsFor(
      [linkedSubject],
      'viewer-1',
    );

    expect(credits.get('sp-linked')).toEqual({
      count: 1,
      faces: [
        { kind: 'persona', name: 'Ember', avatarUrl: null, accent: null },
      ],
    });
  });
});
