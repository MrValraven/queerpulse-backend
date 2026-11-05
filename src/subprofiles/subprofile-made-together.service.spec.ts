import {
  SubprofileKind,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import type {
  CounterpartDirectory,
  CreditMemberIdentity,
  CreditPersonaIdentity,
} from './subprofile-credit-graph';
import {
  MADE_TOGETHER_WINDOW,
  SubprofileMadeTogetherService,
} from './subprofile-made-together.service';
import {
  VISIBLE_SECTIONS_BY_KIND_JSON,
  visibleSectionSql,
} from './subprofile-visible-sections-sql';

// Stubs the fluent `createQueryBuilder('item')` window scan. Every chained
// method returns the builder; `getMany` answers with the rows the test set.
interface WindowScanStub {
  innerJoin: jest.Mock;
  select: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  limit: jest.Mock;
  getMany: jest.Mock;
}

function makeWindowScanStub(rows: unknown[]): WindowScanStub {
  const scan = {} as WindowScanStub;
  for (const method of [
    'innerJoin',
    'select',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'limit',
  ] as const) {
    scan[method] = jest.fn().mockReturnValue(scan);
  }
  scan.getMany = jest.fn().mockResolvedValue(rows);
  return scan;
}

function persona(
  id: string,
  overrides: Partial<CreditPersonaIdentity> = {},
): CreditPersonaIdentity {
  return {
    id,
    handle: `handle-${id}`,
    displayName: `Name ${id}`,
    avatarUrl: null,
    accent: null,
    kind: SubprofileKind.Musician,
    status: SubprofileStatus.Published,
    visibility: SubprofileVisibility.Open,
    linkVisibility: SubprofileLinkVisibility.Unlinked,
    removedAt: null,
    userId: `owner-${id}`,
    isUnderTakedown: false,
    isOwnerBlocked: false,
    ...overrides,
  };
}

let itemCounter = 0;

/** One window row: an item of `authorId` crediting `collaborators`. */
function itemRow(
  authorId: string,
  collaborators: string[],
  createdAt: string,
  overrides: Record<string, unknown> = {},
) {
  itemCounter += 1;
  return {
    id: `item-${itemCounter}`,
    subprofileId: authorId,
    title: `Work ${itemCounter}`,
    imageUrl: null,
    collaborators,
    createdAt: new Date(createdAt),
    ...overrides,
  };
}

function directoryOf(
  personas: CreditPersonaIdentity[],
  members: CreditMemberIdentity[] = [],
  memberHandles: Record<string, string> = {},
): CounterpartDirectory {
  return {
    personaById: new Map(personas.map((entry) => [entry.id, entry])),
    personaIdByHandle: new Map(
      personas.map((entry) => [entry.handle as string, entry.id]),
    ),
    memberByHandle: new Map(
      members.map((member) => [
        memberHandles[member.userId] ?? member.userId,
        member,
      ]),
    ),
    rosterMembersById: new Map(),
  };
}

describe('SubprofileMadeTogetherService.list', () => {
  let windowRows: unknown[];
  let scan: WindowScanStub;
  let directory: CounterpartDirectory;
  let items: { createQueryBuilder: jest.Mock };
  let creditGraph: { resolveCounterparts: jest.Mock };
  let blockFilter: { excludeBlocked: jest.Mock };
  let mediaCropService: { getMany: jest.Mock };
  let service: SubprofileMadeTogetherService;

  beforeEach(() => {
    itemCounter = 0;
    windowRows = [];
    directory = directoryOf([]);
    items = {
      createQueryBuilder: jest.fn(() => {
        scan = makeWindowScanStub(windowRows);
        return scan;
      }),
    };
    creditGraph = {
      resolveCounterparts: jest.fn(() => Promise.resolve(directory)),
    };
    blockFilter = { excludeBlocked: jest.fn() };
    mediaCropService = {
      getMany: jest.fn().mockResolvedValue(new Map()),
    };
    service = new SubprofileMadeTogetherService(
      items as never,
      creditGraph as never,
      blockFilter as never,
      mediaCropService as never,
    );
  });

  it('returns nothing and stops after the window scan when no credited item qualifies', async () => {
    await expect(service.list('viewer-1')).resolves.toEqual({ items: [] });

    expect(items.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(creditGraph.resolveCounterparts).not.toHaveBeenCalled();
    expect(mediaCropService.getMany).not.toHaveBeenCalled();
  });

  it('builds a card from an unlinked author crediting an unlinked partner', async () => {
    const author = persona('a');
    const partner = persona('b');
    directory = directoryOf([author, partner]);
    windowRows = [itemRow('a', ['handle-b'], '2026-10-01T00:00:00Z')];

    const response = await service.list('viewer-1');

    expect(response.items).toHaveLength(1);
    expect(response.items[0]).toMatchObject({
      itemId: 'item-1',
      createdAt: '2026-10-01T00:00:00.000Z',
      author: { handle: 'handle-a', displayName: 'Name a' },
      partner: { handle: 'handle-b', displayName: 'Name b' },
    });
  });

  it('accepts a LINKED author, since the author only has to pass the base gate', async () => {
    const author = persona('a', {
      linkVisibility: SubprofileLinkVisibility.Linked,
    });
    directory = directoryOf([author, persona('b')]);
    windowRows = [itemRow('a', ['handle-b'], '2026-10-01T00:00:00Z')];

    const response = await service.list('viewer-1');

    expect(response.items.map((card) => card.author.handle)).toEqual([
      'handle-a',
    ]);
  });

  it('skips an item whose only credit is a member', async () => {
    const member: CreditMemberIdentity = {
      userId: 'member-1',
      name: 'Casey Member',
      avatarUrl: null,
      isBlocked: false,
    };
    directory = directoryOf([persona('a')], [member], {
      'member-1': 'casey',
    });
    windowRows = [itemRow('a', ['casey'], '2026-10-01T00:00:00Z')];

    await expect(service.list('viewer-1')).resolves.toEqual({ items: [] });
  });

  it('uses the first persona credit and ignores a member credit listed before it', async () => {
    const member: CreditMemberIdentity = {
      userId: 'member-1',
      name: 'Casey Member',
      avatarUrl: null,
      isBlocked: false,
    };
    directory = directoryOf([persona('a'), persona('b')], [member], {
      'member-1': 'casey',
    });
    windowRows = [itemRow('a', ['casey', 'handle-b'], '2026-10-01T00:00:00Z')];

    const response = await service.list('viewer-1');

    expect(response.items[0]?.partner.handle).toBe('handle-b');
  });

  it('never pairs a persona with itself', async () => {
    directory = directoryOf([persona('a')]);
    windowRows = [itemRow('a', ['handle-a'], '2026-10-01T00:00:00Z')];

    await expect(service.list('viewer-1')).resolves.toEqual({ items: [] });
  });

  it('skips a partner that is linked, since a linked persona is never creditable by handle', async () => {
    directory = directoryOf([
      persona('a'),
      persona('b', { linkVisibility: SubprofileLinkVisibility.Linked }),
    ]);
    windowRows = [itemRow('a', ['handle-b'], '2026-10-01T00:00:00Z')];

    await expect(service.list('viewer-1')).resolves.toEqual({ items: [] });
  });

  it.each([
    ['network', { visibility: SubprofileVisibility.Network }],
    ['private', { visibility: SubprofileVisibility.Private }],
    ['draft', { status: SubprofileStatus.Draft }],
    ['removed', { removedAt: new Date('2026-09-01T00:00:00Z') }],
    ['under takedown', { isUnderTakedown: true }],
    ['owned by a blocked member', { isOwnerBlocked: true }],
  ])('skips a partner that is %s', async (_label, overrides) => {
    directory = directoryOf([persona('a'), persona('b', overrides)]);
    windowRows = [itemRow('a', ['handle-b'], '2026-10-01T00:00:00Z')];

    await expect(service.list('viewer-1')).resolves.toEqual({ items: [] });
  });

  it('falls through to a later creditable partner when the first persona credit is not creditable', async () => {
    directory = directoryOf([
      persona('a'),
      persona('b', { visibility: SubprofileVisibility.Network }),
      persona('c'),
    ]);
    windowRows = [
      itemRow('a', ['handle-b', 'handle-c'], '2026-10-01T00:00:00Z'),
    ];

    const response = await service.list('viewer-1');

    expect(response.items[0]?.partner.handle).toBe('handle-c');
  });

  it('skips an item whose author fails the base gate', async () => {
    directory = directoryOf([
      persona('a', { visibility: SubprofileVisibility.Network }),
      persona('b'),
    ]);
    windowRows = [itemRow('a', ['handle-b'], '2026-10-01T00:00:00Z')];

    await expect(service.list('viewer-1')).resolves.toEqual({ items: [] });
  });

  it('includes a pair whose rosters overlap, since a public persona page shows that credit too', async () => {
    // Both personas share an owner. No roster is loaded and none is compared.
    directory = directoryOf([
      persona('a', { userId: 'shared-owner' }),
      persona('b', { userId: 'shared-owner' }),
    ]);
    windowRows = [itemRow('a', ['handle-b'], '2026-10-01T00:00:00Z')];

    const response = await service.list('viewer-1');

    expect(response.items).toHaveLength(1);
    const [, , , options] = creditGraph.resolveCounterparts.mock
      .calls[0] as unknown[];
    expect(options).toBeUndefined();
  });

  it('keeps one card per unordered pair and keeps the newest', async () => {
    directory = directoryOf([persona('a'), persona('b')]);
    windowRows = [
      itemRow('b', ['handle-a'], '2026-10-05T00:00:00Z'),
      itemRow('a', ['handle-b'], '2026-10-03T00:00:00Z'),
      itemRow('a', ['handle-b'], '2026-10-01T00:00:00Z'),
    ];

    const response = await service.list('viewer-1');

    expect(response.items).toHaveLength(1);
    expect(response.items[0]).toMatchObject({
      itemId: 'item-1',
      author: { handle: 'handle-b' },
      partner: { handle: 'handle-a' },
    });
  });

  it('puts a persona on at most two cards, as author or partner', async () => {
    directory = directoryOf([
      persona('a'),
      persona('b'),
      persona('c'),
      persona('d'),
      persona('e'),
    ]);
    windowRows = [
      itemRow('a', ['handle-b'], '2026-10-05T00:00:00Z'),
      itemRow('a', ['handle-c'], '2026-10-04T00:00:00Z'),
      // a already has two cards, so this one is dropped.
      itemRow('a', ['handle-d'], '2026-10-03T00:00:00Z'),
      // d has no cards yet and e none, so this pair still fits.
      itemRow('d', ['handle-e'], '2026-10-02T00:00:00Z'),
      // c as a partner counts too: c has one card, this is its second.
      itemRow('e', ['handle-c'], '2026-10-01T00:00:00Z'),
    ];

    const response = await service.list('viewer-1');

    expect(response.items.map((card) => card.itemId)).toEqual([
      'item-1',
      'item-2',
      'item-4',
      'item-5',
    ]);
  });

  it('does not let a skipped duplicate pair use up the per-persona cap', async () => {
    directory = directoryOf([persona('a'), persona('b'), persona('c')]);
    windowRows = [
      itemRow('a', ['handle-b'], '2026-10-05T00:00:00Z'),
      itemRow('b', ['handle-a'], '2026-10-04T00:00:00Z'),
      itemRow('a', ['handle-c'], '2026-10-03T00:00:00Z'),
    ];

    const response = await service.list('viewer-1');

    expect(response.items.map((card) => card.itemId)).toEqual([
      'item-1',
      'item-3',
    ]);
  });

  it('defaults to eight cards and clamps the limit to 1..12', async () => {
    const personas = [persona('hub-a'), persona('hub-b')];
    const rows: unknown[] = [];
    // Twenty distinct pairs of fresh personas.
    for (let index = 0; index < 20; index += 1) {
      personas.push(persona(`x${index}`), persona(`y${index}`));
      rows.push(
        itemRow(
          `x${index}`,
          [`handle-y${index}`],
          `2026-10-${String(30 - index).padStart(2, '0')}T00:00:00Z`,
        ),
      );
    }
    directory = directoryOf(personas);
    windowRows = rows;

    expect((await service.list('viewer-1')).items).toHaveLength(8);
    expect((await service.list('viewer-1', 3)).items).toHaveLength(3);
    expect((await service.list('viewer-1', 99)).items).toHaveLength(12);
    expect((await service.list('viewer-1', 0)).items).toHaveLength(1);
  });

  it('returns newest first, in window order', async () => {
    directory = directoryOf([
      persona('a'),
      persona('b'),
      persona('c'),
      persona('d'),
    ]);
    windowRows = [
      itemRow('a', ['handle-b'], '2026-10-05T00:00:00Z'),
      itemRow('c', ['handle-d'], '2026-10-02T00:00:00Z'),
    ];

    const response = await service.list('viewer-1');

    expect(response.items.map((card) => card.createdAt)).toEqual([
      '2026-10-05T00:00:00.000Z',
      '2026-10-02T00:00:00.000Z',
    ]);
  });

  it('emits no owner slug, owner name, link visibility or persona id', async () => {
    directory = directoryOf([persona('a'), persona('b')]);
    windowRows = [itemRow('a', ['handle-b'], '2026-10-01T00:00:00Z')];

    const card = (await service.list('viewer-1')).items.at(0);
    if (!card) throw new Error('expected one Made together card');

    expect(Object.keys(card.author).sort()).toEqual(
      [
        'accent',
        'avatarCrop',
        'avatarUrl',
        'displayName',
        'handle',
        'kind',
      ].sort(),
    );
    expect(Object.keys(card.partner)).not.toContain('id');
    expect(JSON.stringify(card)).not.toMatch(/owner|linkVisibility/);
  });

  describe('window query', () => {
    beforeEach(async () => {
      await service.list('viewer-1');
    });

    function clauses(): string[] {
      return [
        ...(scan.where.mock.calls as [string][]),
        ...(scan.andWhere.mock.calls as [string][]),
      ].map((call) => call[0]);
    }

    it('filters credited items with the partial-index predicate collaborators <> {}', () => {
      expect(clauses()).toContain("item.collaborators <> '{}'");
      expect(clauses().join('\n')).not.toContain('cardinality');
    });

    it('excludes the links section and every tattoo body-photo section', () => {
      expect(clauses()).toContain('item.section NOT IN (:...excludedSections)');
      const bound = (
        scan.andWhere.mock.calls as [string, Record<string, unknown>][]
      )
        .map((call) => call[1])
        .find((params) => params?.excludedSections) as {
        excludedSections: string[];
      };
      expect([...bound.excludedSections].sort()).toEqual(
        ['cover_ups', 'healed', 'in_progress', 'links', 'scar_work'].sort(),
      );
    });

    it("keeps only items in sections the author's current kind shows", () => {
      expect(scan.andWhere).toHaveBeenCalledWith(
        visibleSectionSql('"item"."section"', '"sp"."kind"'),
        { visibleSectionsByKind: VISIBLE_SECTIONS_BY_KIND_JSON },
      );
    });

    it('limits the scan to the newest window, ordered by createdAt then id', () => {
      expect(scan.orderBy).toHaveBeenCalledWith('item.createdAt', 'DESC');
      expect(scan.addOrderBy).toHaveBeenCalledWith('item.id', 'ASC');
      expect(scan.limit).toHaveBeenCalledWith(MADE_TOGETHER_WINDOW);
      expect(MADE_TOGETHER_WINDOW).toBe(80);
    });

    it('requires a published, open, not removed author with a handle', () => {
      const joined = clauses().join('\n');
      expect(joined).toContain('sp.status = :published');
      expect(joined).toContain('sp.visibility = :open');
      expect(joined).toContain('sp.removedAt IS NULL');
      expect(joined).toContain('sp.handle IS NOT NULL');
      expect(joined).toContain('content_moderation');
    });

    it('filters authors blocked either way with the viewer in the query', () => {
      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        scan,
        'viewer-1',
        '"sp"."user_id"',
      );
    });
  });

  it('resolves the graph once with every credit handle and author id, and loads crops once', async () => {
    directory = directoryOf([persona('a'), persona('b'), persona('c')]);
    windowRows = [
      itemRow('a', ['handle-b'], '2026-10-05T00:00:00Z', {
        imageUrl: 'work-image/u/i.jpg',
      }),
      itemRow('c', ['handle-b', 'handle-a'], '2026-10-04T00:00:00Z'),
    ];

    await service.list('viewer-1');

    expect(creditGraph.resolveCounterparts).toHaveBeenCalledTimes(1);
    const [handles, authorIds, viewerId] = creditGraph.resolveCounterparts.mock
      .calls[0] as [string[], string[], string];
    expect([...handles].sort()).toEqual(
      ['handle-a', 'handle-b', 'handle-b'].sort(),
    );
    expect([...authorIds].sort()).toEqual(['a', 'c']);
    expect(viewerId).toBe('viewer-1');
    expect(mediaCropService.getMany).toHaveBeenCalledTimes(1);
  });
});
