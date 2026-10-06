import { RosterRole } from '../communities/entities/community-member.entity';
import {
  forumOpNotTakenDownSql,
  forumThreadVisibleSql,
} from './forum-threads.service';
import { fundingSaverVisibleSql } from './funding-saver-visibility';

describe('fundingSaverVisibleSql', () => {
  const saverGateSql = fundingSaverVisibleSql('"thread"', '"saved"');

  it('keeps the call, withdrawal, read, OP takedown and block clauses', () => {
    expect(saverGateSql).toContain(`"thread"."kind" = 'call'`);
    expect(saverGateSql).toContain('"thread"."deleted_at" IS NULL');
    expect(saverGateSql).toContain(forumThreadVisibleSql('"thread"'));
    expect(saverGateSql).toContain(forumOpNotTakenDownSql('"thread"'));
    expect(saverGateSql).toContain(
      '"block"."blocker_id" = "saved"."user_id" AND "block"."blocked_id" = "thread"."author_id"',
    );
    expect(saverGateSql).toContain(
      '"block"."blocked_id" = "saved"."user_id" AND "block"."blocker_id" = "thread"."author_id"',
    );
  });

  it('lets flat and cross-posted threads skip the community gate', () => {
    expect(saverGateSql).toContain('"thread"."community_id" IS NULL');
    expect(saverGateSql).toContain('OR "thread"."cross_posted" = true');
  });

  it('hides a thread only in a gated community, so a public space stays readable off its roster', () => {
    expect(saverGateSql).toMatch(
      /OR NOT EXISTS \(\s*SELECT 1 FROM "communities" "community"\s*WHERE "community"\."id" = "thread"\."community_id"/,
    );
    expect(saverGateSql).toContain(
      `"community"."access_tier" IN ('request', 'invite', 'private')`,
    );
    expect(saverGateSql).not.toContain(`"community"."access_tier" = 'public'`);
    expect(saverGateSql).not.toContain('"community"."parent_id" IS NULL');
  });

  it('counts a space roster row only while the saver still holds the parent roster row', () => {
    expect(saverGateSql).toMatch(
      /AND NOT EXISTS \(\s*SELECT 1 FROM "community_members" "membership"/,
    );
    expect(saverGateSql).toContain(
      '"membership"."community_id" = "community"."id"',
    );
    expect(saverGateSql).toContain(
      '"membership"."user_id" = "saved"."user_id"',
    );
    expect(saverGateSql).toContain('"own_c"."id" = "community"."id"');
    expect(saverGateSql).toContain('"own_c"."parent_id" IS NULL');
    expect(saverGateSql).toContain(
      '"own_pm"."community_id" = "own_c"."parent_id"',
    );
    expect(saverGateSql).toContain('"own_pm"."user_id" = "saved"."user_id"');
  });

  it('opens a gated space to staff of its parent with no space roster row', () => {
    expect(saverGateSql).toMatch(
      /AND NOT EXISTS \(\s*SELECT 1 FROM "communities" "staff_sc"/,
    );
    expect(saverGateSql).toContain('"staff_sc"."id" = "community"."id"');
    expect(saverGateSql).toContain(
      '"staff_pm"."community_id" = "staff_sc"."parent_id"',
    );
    expect(saverGateSql).toContain('"staff_pm"."user_id" = "saved"."user_id"');
    expect(saverGateSql).toContain(
      `"staff_pm"."role" IN ('${RosterRole.Owner}', '${RosterRole.CoOwner}', '${RosterRole.Mod}')`,
    );
  });

  it('binds no parameters, named or numbered, so callers keep their own numbering', () => {
    expect(saverGateSql).not.toMatch(/(?<!:):[A-Za-z_]/);
    expect(saverGateSql).not.toMatch(/\$\d/);
  });

  it('writes the saver column from the alias it is given', () => {
    const renamedSql = fundingSaverVisibleSql('"t"', '"s"');

    expect(renamedSql).toContain('"own_pm"."user_id" = "s"."user_id"');
    expect(renamedSql).toContain('"staff_pm"."user_id" = "s"."user_id"');
    expect(renamedSql).toContain('"membership"."user_id" = "s"."user_id"');
    expect(renamedSql).toContain('"community"."id" = "t"."community_id"');
    expect(renamedSql).not.toContain('"saved"');
  });
});
