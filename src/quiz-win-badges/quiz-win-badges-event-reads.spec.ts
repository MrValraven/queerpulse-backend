import {
  NEXT_GAME_WIN_BADGES_SQL,
  readNextGameWinBadges,
} from './quiz-win-badges-event-reads';

function collapsed(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function fakeManager(rows: unknown[]) {
  const query = jest.fn().mockResolvedValue(rows);
  return { manager: { query }, query };
}

function chipRow(
  gameNumber: number,
  definitionId: string,
  nameEn: string,
  archivedAt: Date | null = null,
) {
  return {
    game_number: gameNumber,
    definition_id: definitionId,
    badge_key: `quiz:${definitionId}`,
    name_en: nameEn,
    name_pt: null,
    icon_key: 'star',
    tint: 'jade',
    rarity: 'rare',
    archived_at: archivedAt,
  };
}

function emptyGameRow(gameNumber: number) {
  return {
    game_number: gameNumber,
    definition_id: null,
    badge_key: null,
    name_en: null,
    name_pt: null,
    icon_key: null,
    tint: null,
    rarity: null,
    archived_at: null,
  };
}

describe('readNextGameWinBadges', () => {
  it('offers the next game badges in slot order', async () => {
    const { manager, query } = fakeManager([
      chipRow(2, 'def-2', 'Trivia Sharpshooter'),
      chipRow(2, 'def-1', 'Quiz Night Champion'),
    ]);

    const preview = await readNextGameWinBadges(manager, 'event-1');

    expect(preview).toEqual({
      gameNumber: 2,
      badges: [
        expect.objectContaining({ definitionId: 'def-2' }),
        expect.objectContaining({ definitionId: 'def-1' }),
      ],
    });
    expect(query).toHaveBeenCalledWith(NEXT_GAME_WIN_BADGES_SQL, ['event-1']);
  });

  it('orders the slots by creation then id and joins them with LEFT JOIN', () => {
    const sql = collapsed(NEXT_GAME_WIN_BADGES_SQL);
    expect(sql).toContain('ORDER BY "slot"."created_at" ASC, "slot"."id" ASC');
    expect(sql).toContain('LEFT JOIN "quiz_event_badge_slots" "slot"');
    expect(sql).toContain('LEFT JOIN "quiz_badge_definitions" "definition"');
  });

  it('offers game 1 to an event whose sessions all predate numbering', () => {
    expect(collapsed(NEXT_GAME_WIN_BADGES_SQL)).toContain(
      'COALESCE(MAX("event_game_number"), 0) + 1',
    );
  });

  it('returns null past the fifth game', async () => {
    const { manager } = fakeManager([
      chipRow(6, 'def-1', 'Quiz Night Champion'),
    ]);

    await expect(readNextGameWinBadges(manager, 'event-1')).resolves.toBeNull();
  });

  it('returns null with no rows and with an empty slot', async () => {
    const noRows = fakeManager([]);
    const emptySlot = fakeManager([emptyGameRow(3)]);

    await expect(
      readNextGameWinBadges(noRows.manager, 'event-1'),
    ).resolves.toBeNull();
    await expect(
      readNextGameWinBadges(emptySlot.manager, 'event-1'),
    ).resolves.toBeNull();
  });

  it('reads the game number of a numeric string', async () => {
    const { manager } = fakeManager([
      { ...chipRow(1, 'def-1', 'Quiz Night Champion'), game_number: '1' },
    ]);

    const preview = await readNextGameWinBadges(manager, 'event-1');

    expect(preview?.gameNumber).toBe(1);
  });

  it('shows an archived badge still on the slot', async () => {
    const { manager } = fakeManager([
      chipRow(1, 'def-1', 'Quiz Night Champion', new Date('2026-11-01')),
    ]);

    const preview = await readNextGameWinBadges(manager, 'event-1');

    expect(preview?.badges).toEqual([
      expect.objectContaining({ definitionId: 'def-1', isArchived: true }),
    ]);
  });

  it('maps the chip columns', async () => {
    const { manager } = fakeManager([
      chipRow(1, 'def-1', 'Quiz Night Champion'),
    ]);

    const preview = await readNextGameWinBadges(manager, 'event-1');

    expect(preview?.badges[0]).toEqual({
      definitionId: 'def-1',
      badgeKey: 'quiz:def-1',
      name: { en: 'Quiz Night Champion', pt: null },
      iconKey: 'star',
      tint: 'jade',
      rarity: 'rare',
      isArchived: false,
    });
  });
});
