import { HttpException } from '@nestjs/common';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { StudioPlaylistEditor } from './entities/studio-playlist-editor.entity';
import {
  StudioPlaylist,
  StudioPlaylistVisibility,
} from './entities/studio-playlist.entity';
import { END_EDITORS_ON_PLAYLIST_SQL } from './studio-playlist-editor-endings';
import {
  ANSWER_INVITE_SQL,
  EDITOR_CANDIDATES_SQL,
  EDITOR_FACTS_SQL,
  EDITOR_ROW_ON_PLAYLIST_SQL,
  LIVE_EDITOR_USER_IDS_SQL,
  LOCK_INVITED_ROW_SQL,
  LOCK_PICKED_CO_OWNER_ROWS_SQL,
  PERSONA_NAME_SQL,
  PLAYLIST_OWNER_ACTIVE_SQL,
  StudioPlaylistEditorsService,
  UPSERT_EDITORS_SQL,
} from './studio-playlist-editors.service';
import { StudioPlaylistReadsService } from './studio-playlist-reads.service';
import {
  LOCK_ACTIVE_EDITOR_ROW_SQL,
  PLAYLIST_CREDIT_STANDS_SQL,
  lockPlaylistFor,
} from './studio-playlist-roles';
import { playlistOwnerIsActiveSql } from './studio-playlist-visibility';

const OWNER_ID = 'ca000000-0000-4000-8000-000000000001';
const FRIEND_ID = 'ca000000-0000-4000-8000-000000000002';
const STRANGER_ID = 'ca000000-0000-4000-8000-000000000003';
const CO_OWNER_ID = 'ca000000-0000-4000-8000-000000000004';
const PLAYLIST_ID = 'ca100000-0000-4000-8000-000000000001';
const PERSONA_ID = 'ca200000-0000-4000-8000-000000000001';
const FRIEND_EDITOR_ROW_ID = 'ca300000-0000-4000-8000-000000000001';
const OTHER_PLAYLIST_EDITOR_ROW_ID = 'ca300000-0000-4000-8000-000000000002';

const playlistRow = (overrides: Partial<StudioPlaylist> = {}): StudioPlaylist =>
  ({
    id: PLAYLIST_ID,
    userId: OWNER_ID,
    name: 'Night bus',
    description: null,
    visibility: StudioPlaylistVisibility.Private,
    creditSubprofileId: null,
    isCreditedToPersona: false,
    ...overrides,
  }) as StudioPlaylist;

interface FactsRow {
  user_id: string;
  is_connected: boolean;
  is_blocked: boolean;
  has_studio_access: boolean;
  is_co_owner: boolean;
}

const facts = (
  userId: string,
  overrides: Partial<FactsRow> = {},
): FactsRow => ({
  user_id: userId,
  is_connected: true,
  is_blocked: false,
  has_studio_access: true,
  is_co_owner: false,
  ...overrides,
});

async function refusalOf(
  promise: Promise<unknown>,
): Promise<{ status?: number; body?: Record<string, unknown> }> {
  try {
    await promise;
    return {};
  } catch (error) {
    const exception = error as HttpException;
    return {
      status: exception.getStatus(),
      body: exception.getResponse() as Record<string, unknown>,
    };
  }
}

describe('StudioPlaylistEditorsService', () => {
  let playlist: StudioPlaylist;
  let liveUserIds: string[];
  let factsByUserId: Map<string, FactsRow>;
  let invitedRows: { id: string; source: string }[];
  let slugRows: { slug: string; userId: string }[];
  let isCreditStanding: boolean;
  let isOwnerActive: boolean;
  let manager: { findOne: jest.Mock; query: jest.Mock };
  let dataSource: {
    transaction: jest.Mock;
    query: jest.Mock;
    manager: typeof manager;
  };
  let playlistReads: {
    viewerRole: jest.Mock;
    isOpenToViewer: jest.Mock;
    peopleByUserIds: jest.Mock;
    getPlaylist: jest.Mock;
  };
  let notifications: { createForRecipients: jest.Mock; create: jest.Mock };
  let playlists: { findOne: jest.Mock };
  let editors: { find: jest.Mock };
  let profiles: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let blockFilter: { blockedUserIds: jest.Mock };
  let service: StudioPlaylistEditorsService;

  const statementsMatching = (sql: string): unknown[][] =>
    (manager.query.mock.calls as [string, unknown[]][])
      .filter(([statement]) => statement === sql)
      .map(([, parameters]) => parameters);

  const statementOrder = (): string[] =>
    (manager.query.mock.calls as [string, unknown[]][]).map(
      ([statement]) => statement,
    );

  beforeEach(() => {
    playlist = playlistRow();
    liveUserIds = [];
    factsByUserId = new Map([
      [FRIEND_ID, facts(FRIEND_ID)],
      [STRANGER_ID, facts(STRANGER_ID, { is_connected: false })],
      [
        CO_OWNER_ID,
        facts(CO_OWNER_ID, { is_connected: false, is_co_owner: true }),
      ],
      [OWNER_ID, facts(OWNER_ID)],
    ]);
    invitedRows = [{ id: 'editor-row-1', source: 'member_invite' }];
    slugRows = [
      { slug: 'friend', userId: FRIEND_ID },
      { slug: 'stranger', userId: STRANGER_ID },
      { slug: 'co-owner', userId: CO_OWNER_ID },
      { slug: 'owner', userId: OWNER_ID },
    ];
    isCreditStanding = true;
    isOwnerActive = true;
    manager = {
      findOne: jest.fn(() => Promise.resolve(playlist)),
      query: jest.fn((sql: string, parameters: unknown[]) => {
        if (sql === LIVE_EDITOR_USER_IDS_SQL) {
          return Promise.resolve(
            liveUserIds.map((userId) => ({ user_id: userId })),
          );
        }
        if (sql === EDITOR_FACTS_SQL) {
          return Promise.resolve(
            (parameters[0] as string[]).flatMap((userId) => {
              const row = factsByUserId.get(userId);
              return row ? [row] : [];
            }),
          );
        }
        if (sql === LOCK_INVITED_ROW_SQL) {
          return Promise.resolve(invitedRows);
        }
        if (sql === EDITOR_ROW_ON_PLAYLIST_SQL) {
          return Promise.resolve(
            parameters[0] === FRIEND_EDITOR_ROW_ID &&
              parameters[1] === PLAYLIST_ID
              ? [{ user_id: FRIEND_ID }]
              : [],
          );
        }
        if (sql === LOCK_ACTIVE_EDITOR_ROW_SQL) {
          return Promise.resolve(
            liveUserIds.includes(parameters[1] as string)
              ? [{ id: 'editor-row-1' }]
              : [],
          );
        }
        if (sql === PLAYLIST_CREDIT_STANDS_SQL) {
          return Promise.resolve([{ is_standing: isCreditStanding }]);
        }
        if (sql === PLAYLIST_OWNER_ACTIVE_SQL) {
          return Promise.resolve([{ is_owner_active: isOwnerActive }]);
        }
        return Promise.resolve([]);
      }),
    };
    dataSource = {
      transaction: jest.fn((work: (inner: typeof manager) => unknown) =>
        Promise.resolve(work(manager)),
      ),
      query: jest.fn((sql: string) =>
        Promise.resolve(
          sql === PERSONA_NAME_SQL ? [{ persona_name: 'Night Shift' }] : [],
        ),
      ),
      manager,
    };
    playlistReads = {
      viewerRole: jest.fn().mockResolvedValue('owner'),
      isOpenToViewer: jest.fn().mockResolvedValue(false),
      peopleByUserIds: jest.fn((userIds: string[]) =>
        Promise.resolve(
          new Map(
            userIds.map((userId) => [
              userId,
              {
                slug: `slug-${userId}`,
                displayName: 'Member',
                avatarUrl: null,
              },
            ]),
          ),
        ),
      ),
      getPlaylist: jest
        .fn()
        .mockResolvedValue({ id: PLAYLIST_ID, role: 'editor' }),
    };
    notifications = {
      createForRecipients: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue(null),
    };
    playlists = { findOne: jest.fn(() => Promise.resolve(playlist)) };
    editors = { find: jest.fn().mockResolvedValue([]) };
    const slugQuery = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn(() => Promise.resolve(slugRows)),
    };
    profiles = {
      findOne: jest.fn((options: { where: { slug: string } }) =>
        Promise.resolve(
          slugRows.find((row) => row.slug === options.where.slug) ?? null,
        ),
      ),
      createQueryBuilder: jest.fn(() => slugQuery),
    };
    blockFilter = {
      blockedUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    };
    service = new StudioPlaylistEditorsService(
      dataSource as unknown as DataSource,
      playlistReads as unknown as StudioPlaylistReadsService,
      notifications as unknown as NotificationsService,
      playlists as unknown as Repository<StudioPlaylist>,
      editors as unknown as Repository<StudioPlaylistEditor>,
      profiles as unknown as Repository<Profile>,
      blockFilter as unknown as BlockFilterService,
    );
  });

  describe('addEditors on a member-credited playlist', () => {
    it('invites a connection, then tells them, and answers the full list', async () => {
      await service.addEditors(OWNER_ID, PLAYLIST_ID, {
        memberSlugs: ['friend'],
      });

      expect(statementsMatching(UPSERT_EDITORS_SQL)).toEqual([
        [PLAYLIST_ID, [FRIEND_ID], OWNER_ID, 'member_invite', 'invited', false],
      ]);
      expect(notifications.createForRecipients).toHaveBeenCalledWith(
        [FRIEND_ID],
        NotificationType.StudioPlaylistEditorInvite,
        {
          playlistId: PLAYLIST_ID,
          playlistName: 'Night bus',
          actorId: OWNER_ID,
        },
        OWNER_ID,
      );
      expect(editors.find).toHaveBeenCalledWith({
        where: { playlistId: PLAYLIST_ID, status: In(['invited', 'active']) },
        order: { invitedAt: 'ASC', id: 'ASC' },
      });
    });

    it('refuses the whole request and names every slug that cannot edit', async () => {
      const refusal = await refusalOf(
        service.addEditors(OWNER_ID, PLAYLIST_ID, {
          memberSlugs: ['friend', 'stranger', 'ghost', 'owner'],
        }),
      );

      expect(refusal.status).toBe(422);
      expect(refusal.body).toEqual(
        expect.objectContaining({
          code: 'studio_playlist_editor_ineligible',
          memberSlugs: ['stranger', 'ghost', 'owner'],
        }),
      );
      expect(statementsMatching(UPSERT_EDITORS_SQL)).toEqual([]);
      expect(notifications.createForRecipients).not.toHaveBeenCalled();
    });

    it.each([
      ['blocked either way', { is_blocked: true }],
      ['without Studio access', { has_studio_access: false }],
    ])('refuses a connection %s', async (_label, overrides) => {
      factsByUserId.set(FRIEND_ID, facts(FRIEND_ID, overrides));
      const refusal = await refusalOf(
        service.addEditors(OWNER_ID, PLAYLIST_ID, { memberSlugs: ['friend'] }),
      );
      expect(refusal.body).toEqual(
        expect.objectContaining({ memberSlugs: ['friend'] }),
      );
    });

    it('skips a member who is already invited or editing, with no second notification', async () => {
      liveUserIds = [FRIEND_ID];
      await service.addEditors(OWNER_ID, PLAYLIST_ID, {
        memberSlugs: ['friend'],
      });
      expect(statementsMatching(UPSERT_EDITORS_SQL)).toEqual([]);
      expect(notifications.createForRecipients).not.toHaveBeenCalled();
    });

    it('refuses an invite past ten editors, invitations counted', async () => {
      liveUserIds = Array.from(
        { length: 10 },
        (_unused, index) => `cc000000-0000-4000-8000-00000000000${index}`,
      );
      expect(
        (
          await refusalOf(
            service.addEditors(OWNER_ID, PLAYLIST_ID, {
              memberSlugs: ['friend'],
            }),
          )
        ).body,
      ).toEqual(
        expect.objectContaining({ code: 'studio_playlist_editor_cap' }),
      );
    });

    it('checks the facts of the members it is adding against the owner and no persona', async () => {
      await service.addEditors(OWNER_ID, PLAYLIST_ID, {
        memberSlugs: ['friend'],
      });
      expect(statementsMatching(EDITOR_FACTS_SQL)).toEqual([
        [[FRIEND_ID], OWNER_ID, null],
      ]);
      expect(statementsMatching(LOCK_PICKED_CO_OWNER_ROWS_SQL)).toEqual([]);
      expect(statementsMatching(PLAYLIST_CREDIT_STANDS_SQL)).toEqual([]);
    });
  });

  describe('addEditors on a persona-credited playlist', () => {
    beforeEach(() => {
      playlist = playlistRow({
        creditSubprofileId: PERSONA_ID,
        isCreditedToPersona: true,
      });
    });

    it('picks a co-owner as an active editor and tells them with the persona name', async () => {
      await service.addEditors(OWNER_ID, PLAYLIST_ID, {
        memberSlugs: ['co-owner'],
      });

      expect(statementsMatching(EDITOR_FACTS_SQL)).toEqual([
        [[CO_OWNER_ID], OWNER_ID, PERSONA_ID],
      ]);
      expect(statementsMatching(UPSERT_EDITORS_SQL)).toEqual([
        [
          PLAYLIST_ID,
          [CO_OWNER_ID],
          OWNER_ID,
          'persona_co_owner',
          'active',
          true,
        ],
      ]);
      expect(notifications.createForRecipients).toHaveBeenCalledWith(
        [CO_OWNER_ID],
        NotificationType.StudioPlaylistEditorAdded,
        {
          playlistId: PLAYLIST_ID,
          playlistName: 'Night bus',
          personaName: 'Night Shift',
          actorId: OWNER_ID,
        },
        OWNER_ID,
      );
    });

    it("locks the picked co-owners' roster rows before reading their facts", async () => {
      await service.addEditors(OWNER_ID, PLAYLIST_ID, {
        memberSlugs: ['co-owner'],
      });

      // The owner's own roster row is held too.
      expect(statementsMatching(LOCK_PICKED_CO_OWNER_ROWS_SQL)).toEqual([
        [PERSONA_ID, [CO_OWNER_ID, OWNER_ID]],
      ]);
      // Lock, then the credit check, then the facts, then the write.
      expect(
        statementOrder().filter((statement) =>
          [
            LOCK_PICKED_CO_OWNER_ROWS_SQL,
            PLAYLIST_CREDIT_STANDS_SQL,
            EDITOR_FACTS_SQL,
            UPSERT_EDITORS_SQL,
          ].includes(statement),
        ),
      ).toEqual([
        LOCK_PICKED_CO_OWNER_ROWS_SQL,
        PLAYLIST_CREDIT_STANDS_SQL,
        EDITOR_FACTS_SQL,
        UPSERT_EDITORS_SQL,
      ]);
      expect(LOCK_PICKED_CO_OWNER_ROWS_SQL).toContain(
        'FOR KEY SHARE OF "member"',
      );
    });

    it('refuses a pick on a persona playlist whose credit stopped standing and notifies nobody', async () => {
      isCreditStanding = false;

      const refusal = await refusalOf(
        service.addEditors(OWNER_ID, PLAYLIST_ID, {
          memberSlugs: ['co-owner', 'friend'],
        }),
      );

      expect(refusal.status).toBe(422);
      expect(refusal.body).toEqual(
        expect.objectContaining({
          code: 'studio_playlist_editor_ineligible',
          memberSlugs: ['co-owner', 'friend'],
        }),
      );
      expect(statementsMatching(LOCK_PICKED_CO_OWNER_ROWS_SQL)).toEqual([
        [PERSONA_ID, [CO_OWNER_ID, FRIEND_ID, OWNER_ID]],
      ]);
      expect(statementsMatching(PLAYLIST_CREDIT_STANDS_SQL)).toEqual([
        [PLAYLIST_ID],
      ]);
      expect(statementsMatching(EDITOR_FACTS_SQL)).toEqual([]);
      expect(statementsMatching(UPSERT_EDITORS_SQL)).toEqual([]);
      expect(notifications.createForRecipients).not.toHaveBeenCalled();
    });

    it('retries the pick once when its first attempt deadlocks', async () => {
      dataSource.transaction.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error('deadlock'), { code: '40P01' })),
      );

      await service.addEditors(OWNER_ID, PLAYLIST_ID, {
        memberSlugs: ['co-owner'],
      });

      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
      expect(statementsMatching(UPSERT_EDITORS_SQL)).toEqual([
        [
          PLAYLIST_ID,
          [CO_OWNER_ID],
          OWNER_ID,
          'persona_co_owner',
          'active',
          true,
        ],
      ]);
      expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
    });

    it('refuses a connection who does not co-own the persona', async () => {
      expect(
        (
          await refusalOf(
            service.addEditors(OWNER_ID, PLAYLIST_ID, {
              memberSlugs: ['friend'],
            }),
          )
        ).body,
      ).toEqual(expect.objectContaining({ memberSlugs: ['friend'] }));
    });
  });

  describe('owner routes', () => {
    it('answers 403 to an editor and 404 to a member who cannot open the playlist', async () => {
      // The friend holds a live editor seat: the row lock admits them as an
      // editor, and the playlist opens to them and to the owner alone.
      liveUserIds = [FRIEND_ID];
      playlistReads.isOpenToViewer.mockImplementation((viewerId: string) =>
        Promise.resolve(
          viewerId === OWNER_ID || liveUserIds.includes(viewerId),
        ),
      );
      await expect(
        lockPlaylistFor(
          manager as unknown as EntityManager,
          PLAYLIST_ID,
          FRIEND_ID,
          'editor',
        ),
      ).resolves.toEqual({ playlist, role: 'editor' });
      expect(statementsMatching(LOCK_ACTIVE_EDITOR_ROW_SQL)).toEqual([
        [PLAYLIST_ID, FRIEND_ID, OWNER_ID],
      ]);
      expect(statementsMatching(END_EDITORS_ON_PLAYLIST_SQL)).toEqual([]);
      manager.query.mockClear();

      const editorRefusal = await refusalOf(
        service.addEditors(FRIEND_ID, PLAYLIST_ID, {
          memberSlugs: ['stranger'],
        }),
      );
      expect(editorRefusal.status).toBe(403);
      expect(editorRefusal.body).toEqual(
        expect.objectContaining({ code: 'studio_playlist_owner_only' }),
      );
      expect(statementsMatching(UPSERT_EDITORS_SQL)).toEqual([]);
      expect(playlistReads.isOpenToViewer).toHaveBeenCalledWith(
        FRIEND_ID,
        PLAYLIST_ID,
      );
      expect(
        (
          await refusalOf(
            service.removeEditor(
              STRANGER_ID,
              PLAYLIST_ID,
              FRIEND_EDITOR_ROW_ID,
            ),
          )
        ).body,
      ).toEqual(expect.objectContaining({ code: 'studio_playlist_not_found' }));
    });

    it('revokes an editor or cancels an invite by the editor row id and clears their added by', async () => {
      await service.removeEditor(OWNER_ID, PLAYLIST_ID, FRIEND_EDITOR_ROW_ID);
      expect(statementsMatching(EDITOR_ROW_ON_PLAYLIST_SQL)).toEqual([
        [FRIEND_EDITOR_ROW_ID, PLAYLIST_ID],
      ]);
      expect(statementsMatching(END_EDITORS_ON_PLAYLIST_SQL)).toEqual([
        [PLAYLIST_ID, [FRIEND_ID], 'revoked'],
      ]);
    });

    it('answers a second removal of the same row as done, since the ending touches live rows only', async () => {
      await service.removeEditor(OWNER_ID, PLAYLIST_ID, FRIEND_EDITOR_ROW_ID);
      await expect(
        service.removeEditor(OWNER_ID, PLAYLIST_ID, FRIEND_EDITOR_ROW_ID),
      ).resolves.toBeUndefined();
      expect(END_EDITORS_ON_PLAYLIST_SQL).toContain(
        `"editor"."status" IN ('invited', 'active')`,
      );
    });

    it('answers 404 with the editor code for an id of another playlist, and ends nothing', async () => {
      const refusal = await refusalOf(
        service.removeEditor(
          OWNER_ID,
          PLAYLIST_ID,
          OTHER_PLAYLIST_EDITOR_ROW_ID,
        ),
      );
      expect(refusal.status).toBe(404);
      expect(refusal.body).toEqual(
        expect.objectContaining({ code: 'studio_playlist_editor_not_found' }),
      );
      expect(statementsMatching(END_EDITORS_ON_PLAYLIST_SQL)).toEqual([]);
    });
  });

  describe('leave', () => {
    it('ends an active editor as left', async () => {
      liveUserIds = [FRIEND_ID];
      await service.leave(FRIEND_ID, PLAYLIST_ID);
      expect(statementsMatching(END_EDITORS_ON_PLAYLIST_SQL)).toEqual([
        [PLAYLIST_ID, [FRIEND_ID], 'left'],
      ]);
    });

    it('does nothing for the owner', async () => {
      await service.leave(OWNER_ID, PLAYLIST_ID);
      expect(statementsMatching(END_EDITORS_ON_PLAYLIST_SQL)).toEqual([]);
    });

    it('answers 404 to a member who holds no seat and cannot open the playlist', async () => {
      expect(
        (await refusalOf(service.leave(STRANGER_ID, PLAYLIST_ID))).status,
      ).toBe(404);
    });
  });

  describe('respondToInvite', () => {
    it('declines, tells the owner, and answers nothing', async () => {
      expect(
        await service.respondToInvite(FRIEND_ID, PLAYLIST_ID, 'decline'),
      ).toBeNull();
      expect(statementsMatching(ANSWER_INVITE_SQL)).toEqual([
        ['editor-row-1', 'declined', false],
      ]);
      expect(notifications.create).toHaveBeenCalledWith(
        OWNER_ID,
        NotificationType.StudioPlaylistEditorInviteDeclined,
        {
          playlistId: PLAYLIST_ID,
          playlistName: 'Night bus',
          actorId: FRIEND_ID,
        },
        FRIEND_ID,
      );
    });

    it('accepts after re-checking the connection and the block, and answers the playlist', async () => {
      const view = await service.respondToInvite(
        FRIEND_ID,
        PLAYLIST_ID,
        'accept',
      );

      expect(statementsMatching(EDITOR_FACTS_SQL)).toEqual([
        [[FRIEND_ID], OWNER_ID, null],
      ]);
      expect(statementsMatching(ANSWER_INVITE_SQL)).toEqual([
        ['editor-row-1', 'active', true],
      ]);
      expect(notifications.create).toHaveBeenCalledWith(
        OWNER_ID,
        NotificationType.StudioPlaylistEditorInviteAccepted,
        {
          playlistId: PLAYLIST_ID,
          playlistName: 'Night bus',
          actorId: FRIEND_ID,
        },
        FRIEND_ID,
      );
      expect(view).toEqual({ id: PLAYLIST_ID, role: 'editor' });
      expect(playlistReads.getPlaylist).toHaveBeenCalledWith(
        FRIEND_ID,
        PLAYLIST_ID,
      );
    });

    it.each([
      ['the connection ended', { is_connected: false }],
      ['a block landed', { is_blocked: true }],
    ])(
      'commits the invite as revoked and answers 409 when %s',
      async (_label, overrides) => {
        factsByUserId.set(FRIEND_ID, facts(FRIEND_ID, overrides));

        const refusal = await refusalOf(
          service.respondToInvite(FRIEND_ID, PLAYLIST_ID, 'accept'),
        );

        expect(refusal.status).toBe(409);
        expect(refusal.body).toEqual(
          expect.objectContaining({
            code: 'studio_playlist_invite_unavailable',
          }),
        );
        expect(statementsMatching(ANSWER_INVITE_SQL)).toEqual([
          ['editor-row-1', 'revoked', false],
        ]);
        // The revoke was written inside a transaction that resolved.
        await expect(
          dataSource.transaction.mock.results[0]?.value,
        ).resolves.toBeDefined();
        expect(notifications.create).not.toHaveBeenCalled();
      },
    );

    it('answers 404 with the invite code to an accept while the owner is not an active account, and leaves the row as it is', async () => {
      isOwnerActive = false;

      const refusal = await refusalOf(
        service.respondToInvite(FRIEND_ID, PLAYLIST_ID, 'accept'),
      );

      expect(refusal.status).toBe(404);
      expect(refusal.body).toEqual(
        expect.objectContaining({ code: 'studio_playlist_invite_not_found' }),
      );
      expect(statementsMatching(PLAYLIST_OWNER_ACTIVE_SQL)).toEqual([
        [PLAYLIST_ID],
      ]);
      expect(statementsMatching(ANSWER_INVITE_SQL)).toEqual([]);
      expect(notifications.create).not.toHaveBeenCalled();
      expect(playlistReads.getPlaylist).not.toHaveBeenCalled();
    });

    it('reads the owner as active through the shared owner predicate', () => {
      expect(PLAYLIST_OWNER_ACTIVE_SQL).toContain(
        playlistOwnerIsActiveSql('playlist'),
      );
    });

    it('answers 404 with the invite code when no invitation is open', async () => {
      invitedRows = [];
      expect(
        (
          await refusalOf(
            service.respondToInvite(FRIEND_ID, PLAYLIST_ID, 'accept'),
          )
        ).body,
      ).toEqual(
        expect.objectContaining({ code: 'studio_playlist_invite_not_found' }),
      );
    });

    it('answers 404 with the invite code when the playlist is gone', async () => {
      manager.findOne.mockResolvedValue(null);
      expect(
        (
          await refusalOf(
            service.respondToInvite(FRIEND_ID, PLAYLIST_ID, 'decline'),
          )
        ).status,
      ).toBe(404);
    });
  });

  describe('listEditors', () => {
    it('gives the owner invited and active rows in invitation order', async () => {
      editors.find.mockResolvedValue([
        {
          id: FRIEND_EDITOR_ROW_ID,
          userId: FRIEND_ID,
          status: 'invited',
          source: 'member_invite',
          invitedAt: new Date('2026-10-14T09:00:00.000Z'),
        },
      ]);

      const list = await service.listEditors(OWNER_ID, PLAYLIST_ID);

      expect(editors.find).toHaveBeenCalledWith({
        where: { playlistId: PLAYLIST_ID, status: In(['invited', 'active']) },
        order: { invitedAt: 'ASC', id: 'ASC' },
      });
      expect(list).toEqual({
        items: [
          {
            editorId: FRIEND_EDITOR_ROW_ID,
            member: {
              slug: `slug-${FRIEND_ID}`,
              displayName: 'Member',
              avatarUrl: null,
            },
            status: 'invited',
            source: 'member_invite',
            invitedAt: '2026-10-14T09:00:00.000Z',
          },
        ],
      });
    });

    it('gives an editor the active rows alone', async () => {
      playlistReads.viewerRole.mockResolvedValue('editor');
      playlistReads.isOpenToViewer.mockResolvedValue(true);
      await service.listEditors(FRIEND_ID, PLAYLIST_ID);
      expect(editors.find).toHaveBeenCalledWith({
        where: { playlistId: PLAYLIST_ID, status: In(['active']) },
        order: { invitedAt: 'ASC', id: 'ASC' },
      });
    });

    it('leaves a member blocked either way with the viewer out of the editor list', async () => {
      playlistReads.viewerRole.mockResolvedValue('editor');
      playlistReads.isOpenToViewer.mockResolvedValue(true);
      editors.find.mockResolvedValue([
        {
          id: FRIEND_EDITOR_ROW_ID,
          userId: FRIEND_ID,
          status: 'active',
          source: 'member_invite',
          invitedAt: new Date('2026-10-14T08:00:00.000Z'),
        },
        {
          id: OTHER_PLAYLIST_EDITOR_ROW_ID,
          userId: STRANGER_ID,
          status: 'active',
          source: 'member_invite',
          invitedAt: new Date('2026-10-14T09:00:00.000Z'),
        },
      ]);
      blockFilter.blockedUserIds.mockResolvedValue(new Set([STRANGER_ID]));

      const list = await service.listEditors(FRIEND_ID, PLAYLIST_ID);

      expect(blockFilter.blockedUserIds).toHaveBeenCalledWith(FRIEND_ID, [
        FRIEND_ID,
        STRANGER_ID,
      ]);
      // The editor's own row stays in their list.
      expect(list.items.map((item) => item.editorId)).toEqual([
        FRIEND_EDITOR_ROW_ID,
      ]);
      expect(playlistReads.peopleByUserIds).toHaveBeenCalledWith([FRIEND_ID]);
    });

    it('leaves out an editor row whose member is not an active account', async () => {
      editors.find.mockResolvedValue([
        {
          id: FRIEND_EDITOR_ROW_ID,
          userId: FRIEND_ID,
          status: 'active',
          source: 'member_invite',
          invitedAt: new Date('2026-10-14T08:00:00.000Z'),
        },
        {
          id: OTHER_PLAYLIST_EDITOR_ROW_ID,
          userId: STRANGER_ID,
          status: 'invited',
          source: 'member_invite',
          invitedAt: new Date('2026-10-14T09:00:00.000Z'),
        },
      ]);
      // The stranger's account is paused: the people read leaves them out.
      playlistReads.peopleByUserIds.mockResolvedValue(
        new Map([
          [
            FRIEND_ID,
            {
              slug: `slug-${FRIEND_ID}`,
              displayName: 'Member',
              avatarUrl: null,
            },
          ],
        ]),
      );

      const list = await service.listEditors(OWNER_ID, PLAYLIST_ID);

      expect(playlistReads.peopleByUserIds).toHaveBeenCalledWith([
        FRIEND_ID,
        STRANGER_ID,
      ]);
      expect(list.items.map((item) => item.editorId)).toEqual([
        FRIEND_EDITOR_ROW_ID,
      ]);
    });

    it('answers 404 for the editor list of a private playlist to a stranger', async () => {
      playlistReads.viewerRole.mockResolvedValue(null);
      expect(
        (await refusalOf(service.listEditors(STRANGER_ID, PLAYLIST_ID))).status,
      ).toBe(404);
      expect(editors.find).not.toHaveBeenCalled();
    });

    it('answers 403 to an invitee who can open the playlist', async () => {
      playlistReads.viewerRole.mockResolvedValue('invitee');
      playlistReads.isOpenToViewer.mockResolvedValue(true);
      expect(
        (await refusalOf(service.listEditors(FRIEND_ID, PLAYLIST_ID))).status,
      ).toBe(403);
    });
  });

  describe('listCandidates', () => {
    it('answers the source mismatch for a member-credited playlist', async () => {
      expect(
        (
          await refusalOf(
            service.listCandidates(OWNER_ID, PLAYLIST_ID, undefined),
          )
        ).body,
      ).toEqual(
        expect.objectContaining({
          code: 'studio_playlist_editor_source_mismatch',
        }),
      );
    });

    it('lists the co-owners of the credit persona with an escaped search and a flag for editors', async () => {
      playlist = playlistRow({
        creditSubprofileId: PERSONA_ID,
        isCreditedToPersona: true,
      });
      dataSource.query.mockResolvedValue([
        { user_id: CO_OWNER_ID, is_editor: true },
      ]);

      const list = await service.listCandidates(OWNER_ID, PLAYLIST_ID, ' 50% ');

      expect(dataSource.query).toHaveBeenCalledWith(EDITOR_CANDIDATES_SQL, [
        PERSONA_ID,
        OWNER_ID,
        PLAYLIST_ID,
        '%50\\%%',
        50,
      ]);
      expect(list).toEqual({
        items: [
          {
            member: {
              slug: `slug-${CO_OWNER_ID}`,
              displayName: 'Member',
              avatarUrl: null,
            },
            isEditor: true,
          },
        ],
      });
    });

    it('lists no candidates while the persona credit does not stand', async () => {
      playlist = playlistRow({
        creditSubprofileId: PERSONA_ID,
        isCreditedToPersona: true,
      });
      isCreditStanding = false;
      dataSource.query.mockResolvedValue([
        { user_id: CO_OWNER_ID, is_editor: false },
      ]);

      expect(
        await service.listCandidates(OWNER_ID, PLAYLIST_ID, undefined),
      ).toEqual({ items: [] });
      expect(statementsMatching(PLAYLIST_CREDIT_STANDS_SQL)).toEqual([
        [PLAYLIST_ID],
      ]);
      expect(dataSource.query).not.toHaveBeenCalledWith(
        EDITOR_CANDIDATES_SQL,
        expect.anything(),
      );
    });

    it('answers 404 to a member who cannot open the playlist', async () => {
      expect(
        (
          await refusalOf(
            service.listCandidates(STRANGER_ID, PLAYLIST_ID, undefined),
          )
        ).status,
      ).toBe(404);
    });

    it('keeps blocked members, members with no grant and the owner out of the candidates', () => {
      expect(EDITOR_CANDIDATES_SQL).toContain(`"member"."user_id" <> $2`);
      expect(EDITOR_CANDIDATES_SQL).toContain('"candidate_grant"');
      expect(EDITOR_CANDIDATES_SQL).toContain('NOT EXISTS');
      expect(EDITOR_CANDIDATES_SQL).toContain('LIMIT $5');
    });
  });
});
