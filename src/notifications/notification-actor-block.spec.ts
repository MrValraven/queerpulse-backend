import { FindOperator } from 'typeorm';
import { NotificationType } from './entities/notification.entity';
import {
  ACTOR_BLOCK_READER_PARAMETER,
  visibleThroughActorBlocks,
} from './notification-actor-block';
import { ACTOR_PAYLOAD_KEY } from './notification-response';

describe('visibleThroughActorBlocks (PRD-403)', () => {
  const condition = visibleThroughActorBlocks('reader-1');
  const findSql = condition.getSql?.('Notification.id') ?? '';
  const updateSql = condition.getSql?.('id') ?? '';

  it('is a raw find operator bound to the reader id', () => {
    expect(condition).toBeInstanceOf(FindOperator);
    expect(condition.objectLiteralParameters).toEqual({
      [ACTOR_BLOCK_READER_PARAMETER]: 'reader-1',
    });
  });

  it('reads the row type and payload through the find alias', () => {
    expect(findSql).toContain('(Notification.type)::text');
    expect(findSql).toContain("(Notification.payload) ->> 'actorId'");
  });

  it('reads the bare columns in an update, where TypeORM uses no alias', () => {
    expect(updateSql).toContain('(type)::text');
    expect(updateSql).toContain("(payload) ->> 'actorId'");
    expect(updateSql).not.toContain('Notification.');
  });

  it('resolves every actor-bearing type through its own payload key', () => {
    for (const [type, payloadKey] of Object.entries(ACTOR_PAYLOAD_KEY)) {
      const arm = new RegExp(
        `WHEN \\(Notification\\.type\\)::text IN \\([^)]*'${type}'[^)]*\\) THEN \\(Notification\\.payload\\) ->> '${payloadKey}'`,
      );
      expect(findSql).toMatch(arm);
    }
  });

  it('never hides a system row, whose type names no actor', () => {
    expect(
      ACTOR_PAYLOAD_KEY[NotificationType.WaitlistPromoted],
    ).toBeUndefined();
    expect(findSql).not.toContain(`'${NotificationType.WaitlistPromoted}'`);
    // A NULL actor becomes '' before the NOT IN, so the row stays visible.
    expect(findSql).toMatch(/^COALESCE\(\(CASE .* END\), ''\) NOT IN \(/s);
  });

  it('checks blocks in both directions against the live table', () => {
    expect(findSql).toMatch(
      /"__actor_block"\."blocked_id"::text FROM "blocks" "__actor_block"\s+WHERE "__actor_block"\."blocker_id" = :actorBlockReaderUserId/,
    );
    expect(findSql).toMatch(
      /"__actor_block"\."blocker_id"::text FROM "blocks" "__actor_block"\s+WHERE "__actor_block"\."blocked_id" = :actorBlockReaderUserId/,
    );
  });

  it('keeps the block lookup uncorrelated, so Postgres runs it once per statement', () => {
    const blockSubquery = findSql.slice(findSql.indexOf('NOT IN ('));
    expect(blockSubquery).not.toContain('Notification.');
  });
});
