import { HttpException } from '@nestjs/common';
import { DataSource, In, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { encodeStudioCursor } from './studio-cursor';
import { RELEASE_FOR_VIEWER_SQL } from './studio-purchase-rows';
import {
  RELEASE_WALL_SQL,
  ReleaseWallRow,
  StudioPurchaseWallService,
} from './studio-purchase-wall.service';
import { SupporterPersonaRow } from './studio-supporters';
import { SUPPORTER_PERSONAS_SQL } from './studio-supporters.service';

const VIEWER_ID = 'fe000000-0000-4000-8000-000000000001';
const RELEASE_ID = 'fe000000-0000-4000-8000-000000000101';
const PERSONA_ID = 'fe000000-0000-4000-8000-000000000201';
const GONE_PERSONA_ID = 'fe000000-0000-4000-8000-000000000202';
const PERSONA_BUYER_ID = 'fe000000-0000-4000-8000-000000000301';
const GONE_PERSONA_BUYER_ID = 'fe000000-0000-4000-8000-000000000302';
const PERSONA_PURCHASE_ID = 'fe000000-0000-4000-8000-000000000401';
const GONE_PERSONA_PURCHASE_ID = 'fe000000-0000-4000-8000-000000000402';

const RELEASE_ROW = { release_id: RELEASE_ID, release_title: 'Low tide' };

const PERSONA_ROW: SupporterPersonaRow = {
  id: PERSONA_ID,
  handle: 'paper-lanterns',
  display_name: 'Paper Lanterns',
  kind: 'writer',
  avatar_url: null,
  is_linkable: true,
};

const BASE_DECIDED_AT = Date.parse('2026-10-20T10:00:00.000Z');

/** The purchase id at position `index` of a page. */
function purchaseIdAt(index: number): string {
  return `fc000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function buyerIdAt(index: number): string {
  return `fd000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function decidedAtOf(index: number): Date {
  return new Date(BASE_DECIDED_AT - index * 60_000);
}

function accountRowAt(index: number): ReleaseWallRow {
  return {
    id: purchaseIdAt(index),
    buyer_user_id: buyerIdAt(index),
    is_shown_as_persona: false,
    shown_as_subprofile_id: null,
    decided_at: decidedAtOf(index),
  };
}

function profileAt(index: number): Partial<Profile> {
  return {
    userId: buyerIdAt(index),
    slug: `member-${index}`,
    firstName: 'Member',
    lastName: String(index),
    pronouns: null,
    avatarUrl: null,
    photoVisible: true,
  };
}

/** The response body of a refused call. */
async function refusalBodyOf(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    if (error instanceof HttpException) {
      return error.getResponse();
    }
    throw error;
  }
  throw new Error('The call resolved; a refusal was expected');
}

describe('StudioPurchaseWallService', () => {
  let releaseRows: unknown[];
  let wallRows: ReleaseWallRow[];
  let personaRows: SupporterPersonaRow[];
  let query: jest.Mock;
  let profiles: { find: jest.Mock };
  let service: StudioPurchaseWallService;

  const sqlCalled = (): string[] =>
    query.mock.calls.map((call: unknown[]) => call[0] as string);

  beforeEach(() => {
    releaseRows = [RELEASE_ROW];
    wallRows = [];
    personaRows = [];
    query = jest.fn((sql: string) => {
      switch (sql) {
        case RELEASE_FOR_VIEWER_SQL:
          return Promise.resolve(releaseRows);
        case RELEASE_WALL_SQL:
          return Promise.resolve(wallRows);
        case SUPPORTER_PERSONAS_SQL:
          return Promise.resolve(personaRows);
        default:
          return Promise.resolve([]);
      }
    });
    profiles = { find: jest.fn().mockResolvedValue([]) };
    service = new StudioPurchaseWallService(
      { query } as unknown as DataSource,
      profiles as unknown as Repository<Profile>,
    );
  });

  it('answers studio_purchase_item_not_found for a release the viewer cannot read', async () => {
    releaseRows = [];

    const body = await refusalBodyOf(
      service.listWall(VIEWER_ID, RELEASE_ID, undefined),
    );

    expect(body).toEqual({
      statusCode: 404,
      code: 'studio_purchase_item_not_found',
      message: 'This music is not available to you.',
    });
    expect(query.mock.calls).toEqual([
      [RELEASE_FOR_VIEWER_SQL, [RELEASE_ID, VIEWER_ID]],
    ]);
    expect(profiles.find).not.toHaveBeenCalled();
  });

  it('reads 25 rows for a page of 24 and keys accounts by purchase id', async () => {
    const indexes = Array.from({ length: 25 }, (_value, index) => index);
    wallRows = indexes.map(accountRowAt);
    profiles.find.mockResolvedValue(indexes.map(profileAt));

    const page = await service.listWall(VIEWER_ID, RELEASE_ID, undefined);

    expect(query.mock.calls).toEqual([
      [RELEASE_FOR_VIEWER_SQL, [RELEASE_ID, VIEWER_ID]],
      [RELEASE_WALL_SQL, [RELEASE_ID, VIEWER_ID, null, null, 25]],
    ]);
    expect(page.items.map((entry) => entry.key)).toEqual(
      indexes.slice(0, 24).map((index) => `account:${purchaseIdAt(index)}`),
    );
    expect(page.items.slice(0, 2).map((entry) => entry.identity)).toEqual([
      {
        kind: 'account',
        member: { slug: 'member-0', displayName: 'Member 0', avatarUrl: null },
      },
      {
        kind: 'account',
        member: { slug: 'member-1', displayName: 'Member 1', avatarUrl: null },
      },
    ]);
    expect(page.pageInfo).toEqual({
      hasMore: true,
      nextCursor: encodeStudioCursor({
        publishedAt: decidedAtOf(23),
        id: purchaseIdAt(23),
      }),
    });
    expect(profiles.find).toHaveBeenCalledTimes(1);
    expect(profiles.find).toHaveBeenCalledWith({
      where: { userId: In(indexes.slice(0, 24).map(buyerIdAt)) },
    });
    expect(sqlCalled()).not.toContain(SUPPORTER_PERSONAS_SQL);
    const serializedPage = JSON.stringify(page);
    for (const index of indexes) {
      expect(serializedPage).not.toContain(buyerIdAt(index));
    }
  });

  it('passes the decoded cursor position to the wall read', async () => {
    const cursor = encodeStudioCursor({
      publishedAt: decidedAtOf(23),
      id: purchaseIdAt(23),
    });

    const page = await service.listWall(VIEWER_ID, RELEASE_ID, cursor);

    expect(query.mock.calls).toEqual([
      [RELEASE_FOR_VIEWER_SQL, [RELEASE_ID, VIEWER_ID]],
      [
        RELEASE_WALL_SQL,
        [RELEASE_ID, VIEWER_ID, decidedAtOf(23), purchaseIdAt(23), 25],
      ],
    ]);
    expect(page).toEqual({
      items: [],
      pageInfo: { hasMore: false, nextCursor: null },
    });
  });

  it('keys a persona entry by the persona id and drops a row whose persona no longer resolves', async () => {
    wallRows = [
      accountRowAt(0),
      {
        id: PERSONA_PURCHASE_ID,
        buyer_user_id: PERSONA_BUYER_ID,
        is_shown_as_persona: true,
        shown_as_subprofile_id: PERSONA_ID,
        decided_at: decidedAtOf(1),
      },
      {
        id: GONE_PERSONA_PURCHASE_ID,
        buyer_user_id: GONE_PERSONA_BUYER_ID,
        is_shown_as_persona: true,
        shown_as_subprofile_id: GONE_PERSONA_ID,
        decided_at: decidedAtOf(2),
      },
    ];
    personaRows = [PERSONA_ROW];
    profiles.find.mockResolvedValue([profileAt(0)]);

    const page = await service.listWall(VIEWER_ID, RELEASE_ID, undefined);

    expect(page).toEqual({
      items: [
        {
          key: `account:${purchaseIdAt(0)}`,
          identity: {
            kind: 'account',
            member: {
              slug: 'member-0',
              displayName: 'Member 0',
              avatarUrl: null,
            },
          },
        },
        {
          key: `persona:${PERSONA_ID}`,
          identity: {
            kind: 'persona',
            persona: {
              id: PERSONA_ID,
              handle: 'paper-lanterns',
              name: 'Paper Lanterns',
              kind: 'writer',
              avatarUrl: null,
              isLinkable: true,
            },
          },
        },
      ],
      pageInfo: { hasMore: false, nextCursor: null },
    });
    expect(
      query.mock.calls.filter(
        (call: unknown[]) => call[0] === SUPPORTER_PERSONAS_SQL,
      ),
    ).toEqual([[SUPPORTER_PERSONAS_SQL, [[PERSONA_ID, GONE_PERSONA_ID]]]]);
    expect(profiles.find).toHaveBeenCalledWith({
      where: { userId: In([buyerIdAt(0)]) },
    });
    const serializedPage = JSON.stringify(page);
    expect(serializedPage).not.toContain(PERSONA_BUYER_ID);
    expect(serializedPage).not.toContain(GONE_PERSONA_BUYER_ID);
    expect(serializedPage).not.toContain(GONE_PERSONA_PURCHASE_ID);
  });

  it('selects no amount', () => {
    expect(RELEASE_WALL_SQL).not.toMatch(/amount_cents/);
  });
});
