import {
  blockedWithAnyPersonaMemberSql,
  chosenPersonaShowableSql,
  personaIdentityBlockedBySql,
  personaMemberUserIdsSql,
} from './studio-persona-members';

describe('Studio persona members', () => {
  it('reads the co-owner rows and the persona creator', () => {
    const sql = personaMemberUserIdsSql('$1');
    expect(sql).toContain('"subprofile_members"');
    expect(sql).toContain('"subprofiles"');
    expect(sql).toMatch(/UNION/);
    expect(sql.match(/\$1/g)).toHaveLength(2);
  });

  it('checks a block in both directions against every member', () => {
    const sql = blockedWithAnyPersonaMemberSql('"playlist"."user_id"', '$1');
    expect(sql).toMatch(/^EXISTS \(/);
    expect(sql).toContain('"blocker_id" = "playlist"."user_id"');
    expect(sql).toContain('"blocked_id" = "playlist"."user_id"');
  });

  it('reads direct and carried identity blocks of the persona by any listed blocker', () => {
    const sql = personaIdentityBlockedBySql(
      personaMemberUserIdsSql('$1'),
      '"supporter"."shown_as_subprofile_id"',
    );
    expect(sql).toMatch(/^EXISTS \(/);
    expect(sql).toContain('"identity_blocks"');
    expect(sql).toContain('"identities"');
    expect(sql).toContain(
      '"blocked_subprofile_id" = "supporter"."shown_as_subprofile_id"',
    );
  });

  it('shows a chosen persona that exists, is not removed and has no moderator hide or removal', () => {
    const sql = chosenPersonaShowableSql('"purchase"."shown_as_subprofile_id"');
    expect(sql).toMatch(/^EXISTS \(/);
    expect(sql).toContain(
      `"chosen_persona"."id" = "purchase"."shown_as_subprofile_id"`,
    );
    expect(sql).toContain(`"chosen_persona"."removed_at" IS NULL`);
    expect(sql).toContain(
      `"chosen_persona_moderation"."subject_type" = 'subprofile'`,
    );
  });
});
