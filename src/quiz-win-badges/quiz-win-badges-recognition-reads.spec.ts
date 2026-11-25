import {
  MEMBER_QUIZ_AWARDS_SQL,
  MEMBER_QUIZ_WINS_SQL,
  isKnownQuizBadgeKey,
  readQuizBadgesForMember,
  type QuizReadTarget,
} from './quiz-win-badges-recognition-reads';

const awardRows = [
  {
    badge_key: 'quiz:def-1',
    hidden_from_profile: false,
    awarded_at: new Date('2026-10-02T21:00:00.000Z'),
    definition_id: 'def-1',
    name_en: 'Quiz Champion',
    name_pt: null,
    description_en: 'Won a quiz night game.',
    description_pt: null,
    icon_key: 'star',
    tint: 'accent',
    rarity: 'rare',
  },
];

/** Newest win first, as the SQL orders them. */
const winRows = [
  {
    badge_definition_id: 'def-1',
    won_at: new Date('2026-11-20T22:00:00.000Z'),
    game_number: 1,
    event_name_snapshot: 'Leather Night Quiz',
    event_was_public: true,
    event_was_adults_only: true,
    event_slug: 'leather-night-quiz',
    event_is_public_now: true,
    event_is_adults_only_now: true,
    win_count: 2,
  },
  {
    badge_definition_id: 'def-1',
    won_at: new Date('2026-10-02T21:00:00.000Z'),
    game_number: 2,
    event_name_snapshot: 'Pride Quiz Night',
    event_was_public: true,
    event_was_adults_only: false,
    event_slug: 'pride-quiz-night',
    event_is_public_now: true,
    event_is_adults_only_now: false,
    win_count: 2,
  },
];

/** Collapses whitespace so assertions ignore the SQL layout. */
function collapsed(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** Answers the award read with `awards` and the win read with `wins`. */
function recordingManager(awards: unknown[], wins: unknown[] = []) {
  const query = jest.fn((sql: string) =>
    Promise.resolve(sql === MEMBER_QUIZ_AWARDS_SQL ? awards : wins),
  );
  return { manager: { query } as unknown as QuizReadTarget, query };
}

describe('quiz win badges recognition reads', () => {
  it('gives the owner every win with names, slug and the 18+ flag', async () => {
    const { manager } = recordingManager(awardRows, winRows);
    const badges = await readQuizBadgesForMember(manager, 'user-1', {
      isOwnerView: true,
    });
    expect(badges[0]?.details.wins[0]).toEqual({
      wonAt: '2026-11-20T22:00:00.000Z',
      gameNumber: 1,
      eventName: 'Leather Night Quiz',
      eventSlug: 'leather-night-quiz',
      isAdultsOnlyEvent: true,
    });
  });

  it('masks a win at an 18+ or non-public event for another viewer', async () => {
    const { manager } = recordingManager(awardRows, winRows);
    const [badge] = await readQuizBadgesForMember(manager, 'user-1', {
      isOwnerView: false,
    });
    expect(badge?.details.wins).toEqual([
      {
        wonAt: '2026-11-20T00:00:00.000Z',
        gameNumber: 1,
        eventName: null,
        eventSlug: null,
        isAdultsOnlyEvent: false,
      },
      {
        wonAt: '2026-10-02T21:00:00.000Z',
        gameNumber: 2,
        eventName: 'Pride Quiz Night',
        eventSlug: 'pride-quiz-night',
        isAdultsOnlyEvent: false,
      },
    ]);
    expect(badge?.details.winCount).toBe(2);
  });

  it('masks a win at a non-public event for another viewer', async () => {
    const privateWinRows = [
      {
        ...winRows[1],
        event_was_public: false,
      },
    ];
    const { manager } = recordingManager(awardRows, privateWinRows);
    const [badge] = await readQuizBadgesForMember(manager, 'user-1', {
      isOwnerView: false,
    });
    expect(badge?.details.wins[0]).toMatchObject({
      wonAt: '2026-10-02T00:00:00.000Z',
      eventName: null,
      eventSlug: null,
      isAdultsOnlyEvent: false,
    });
  });

  it('masks a win for another viewer when the live event is no longer public and published', async () => {
    const unpublishedWinRows = [{ ...winRows[1], event_is_public_now: false }];
    const { manager } = recordingManager(awardRows, unpublishedWinRows);
    const [badge] = await readQuizBadgesForMember(manager, 'user-1', {
      isOwnerView: false,
    });
    expect(badge?.details.wins[0]).toEqual({
      wonAt: '2026-10-02T00:00:00.000Z',
      gameNumber: 2,
      eventName: null,
      eventSlug: null,
      isAdultsOnlyEvent: false,
    });
  });

  it('masks a win for another viewer when the live event is now 18+', async () => {
    const nowAdultsWinRows = [
      { ...winRows[1], event_is_adults_only_now: true },
    ];
    const { manager } = recordingManager(awardRows, nowAdultsWinRows);
    const [badge] = await readQuizBadgesForMember(manager, 'user-1', {
      isOwnerView: false,
    });
    expect(badge?.details.wins[0]).toMatchObject({
      wonAt: '2026-10-02T00:00:00.000Z',
      eventName: null,
      eventSlug: null,
    });
  });

  it('shows the kept name and exact time to another viewer when a public event is gone', async () => {
    const goneEventWinRows = [
      {
        ...winRows[1],
        event_slug: null,
        event_is_public_now: null,
        event_is_adults_only_now: null,
      },
    ];
    const { manager } = recordingManager(awardRows, goneEventWinRows);
    const [badge] = await readQuizBadgesForMember(manager, 'user-1', {
      isOwnerView: false,
    });
    expect(badge?.details.wins[0]).toEqual({
      wonAt: '2026-10-02T21:00:00.000Z',
      gameNumber: 2,
      eventName: 'Pride Quiz Night',
      eventSlug: null,
      isAdultsOnlyEvent: false,
    });
  });

  it('gives the owner the exact time and the name whatever the live event became', async () => {
    const changedEventWinRows = [
      {
        ...winRows[1],
        event_was_public: false,
        event_is_public_now: false,
        event_is_adults_only_now: true,
      },
    ];
    const { manager } = recordingManager(awardRows, changedEventWinRows);
    const [badge] = await readQuizBadgesForMember(manager, 'user-1', {
      isOwnerView: true,
    });
    expect(badge?.details.wins[0]).toEqual({
      wonAt: '2026-10-02T21:00:00.000Z',
      gameNumber: 2,
      eventName: 'Pride Quiz Night',
      eventSlug: 'pride-quiz-night',
      isAdultsOnlyEvent: false,
    });
  });

  it('reads the live public and 18+ state of an event that still exists', () => {
    const winsSql = collapsed(MEMBER_QUIZ_WINS_SQL);
    expect(winsSql).toContain(
      `CASE WHEN "event"."id" IS NULL THEN NULL ELSE ("event"."visibility" = 'public' AND "event"."status" = 'published') END AS "event_is_public_now"`,
    );
    expect(winsSql).toContain(
      `CASE WHEN "event"."id" IS NULL THEN NULL ELSE COALESCE(("event"."format_details" ->> 'isAdultsOnly') = 'true', false) END AS "event_is_adults_only_now"`,
    );
  });

  it('keeps a null slug for the owner when the event is gone', async () => {
    const goneEventWinRows = [{ ...winRows[1], event_slug: null }];
    const { manager } = recordingManager(awardRows, goneEventWinRows);
    const [badge] = await readQuizBadgesForMember(manager, 'user-1', {
      isOwnerView: true,
    });
    expect(badge?.details.wins[0]).toMatchObject({
      eventName: 'Pride Quiz Night',
      eventSlug: null,
    });
  });

  it('maps the definition into the badge and its details', async () => {
    const { manager, query } = recordingManager(awardRows, winRows);
    const [badge] = await readQuizBadgesForMember(manager, 'user-1', {
      isOwnerView: true,
    });
    expect(badge).toMatchObject({
      badgeKey: 'quiz:def-1',
      rarity: 'rare',
      tint: 'accent',
      hiddenFromProfile: false,
      awardedAt: new Date('2026-10-02T21:00:00.000Z'),
    });
    expect(badge?.details).toMatchObject({
      definitionId: 'def-1',
      name: { en: 'Quiz Champion', pt: null },
      description: { en: 'Won a quiz night game.', pt: null },
      iconKey: 'star',
      winCount: 2,
    });
    expect(query).toHaveBeenNthCalledWith(2, MEMBER_QUIZ_WINS_SQL, [
      'user-1',
      ['def-1'],
      100,
    ]);
  });

  it('gives another viewer the award time at day precision and the owner the exact time', async () => {
    const lateAwardRows = [
      { ...awardRows[0], awarded_at: new Date('2026-10-02T21:00:00.000Z') },
    ];
    const otherViewer = recordingManager(lateAwardRows, winRows);
    const [otherViewerBadge] = await readQuizBadgesForMember(
      otherViewer.manager,
      'user-1',
      { isOwnerView: false },
    );
    expect(otherViewerBadge?.awardedAt).toEqual(
      new Date('2026-10-02T00:00:00.000Z'),
    );

    const owner = recordingManager(lateAwardRows, winRows);
    const [ownerBadge] = await readQuizBadgesForMember(
      owner.manager,
      'user-1',
      {
        isOwnerView: true,
      },
    );
    expect(ownerBadge?.awardedAt).toEqual(new Date('2026-10-02T21:00:00.000Z'));
  });

  it('drops a hidden quiz badge from another viewer', async () => {
    const { manager, query } = recordingManager([]);
    await readQuizBadgesForMember(manager, 'user-1', { isOwnerView: false });
    expect(query).toHaveBeenCalledWith(MEMBER_QUIZ_AWARDS_SQL, [
      'user-1',
      false,
    ]);
    expect(collapsed(MEMBER_QUIZ_AWARDS_SQL)).toContain(
      '($2::boolean OR "award"."hidden_from_profile" = false)',
    );
  });

  it('runs no win query when there is no award row', async () => {
    const { manager, query } = recordingManager([]);
    const badges = await readQuizBadgesForMember(manager, 'user-1', {
      isOwnerView: true,
    });
    expect(badges).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('caps the listed wins per badge and counts them all', () => {
    const winsSql = collapsed(MEMBER_QUIZ_WINS_SQL);
    expect(winsSql).toContain(
      'COUNT(*) OVER (PARTITION BY "win"."badge_definition_id")::int AS "win_count"',
    );
    expect(winsSql).toContain(
      'ROW_NUMBER() OVER (PARTITION BY "win"."badge_definition_id" ORDER BY "win"."won_at" DESC, "win"."id" DESC)',
    );
    expect(winsSql).toContain('WHERE "ranked"."position" <= $3');
  });

  it('skips an award row with no live win', async () => {
    const orphanAwardRow = {
      ...awardRows[0],
      badge_key: 'quiz:def-3',
      definition_id: 'def-3',
    };
    const { manager } = recordingManager(
      [...awardRows, orphanAwardRow],
      winRows,
    );
    const badges = await readQuizBadgesForMember(manager, 'user-1', {
      isOwnerView: true,
    });
    expect(badges.map((badge) => badge.badgeKey)).toEqual(['quiz:def-1']);
  });

  it('skips the only award row when it has no live win', async () => {
    const { manager } = recordingManager(awardRows, []);
    const badges = await readQuizBadgesForMember(manager, 'user-1', {
      isOwnerView: true,
    });
    expect(badges).toEqual([]);
  });

  describe('isKnownQuizBadgeKey', () => {
    it('knows an archived definition key', async () => {
      const query = jest.fn().mockResolvedValue([{ exists: true }]);
      const manager = { query } as unknown as QuizReadTarget;
      await expect(isKnownQuizBadgeKey(manager, 'quiz:def-1')).resolves.toBe(
        true,
      );
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('FROM "quiz_badge_definitions"'),
        ['quiz:def-1'],
      );
    });

    it('answers false for a quiz key with no definition', async () => {
      const query = jest.fn().mockResolvedValue([{ exists: false }]);
      const manager = { query } as unknown as QuizReadTarget;
      await expect(isKnownQuizBadgeKey(manager, 'quiz:gone')).resolves.toBe(
        false,
      );
    });

    it('refuses a code key without a query', async () => {
      const query = jest.fn();
      const manager = { query } as unknown as QuizReadTarget;
      await expect(
        isKnownQuizBadgeKey(manager, 'first-gathering'),
      ).resolves.toBe(false);
      expect(query).not.toHaveBeenCalled();
    });
  });
});
