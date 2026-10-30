import {
  anonymousVisibleMemberSql,
  anonymousVisiblePersonaSql,
  eligibleMemberSql,
  eligiblePersonaSql,
  LISTING_MODERATION_SUBJECT_TYPES,
  MEMBER_MODERATION_SUBJECT_TYPE,
  notAdultListingSql,
  notBlockedEitherWaySql,
  notHiddenFromViewerSql,
  publiclyVisibleListingSql,
} from './listing-team-visibility';

describe('listing team visibility SQL', () => {
  it('requires all six eligibility conditions', () => {
    const sql = eligiblePersonaSql('persona');
    expect(sql).toContain(`"persona"."status" = 'published'`);
    expect(sql).toContain(`"persona"."removed_at" IS NULL`);
    expect(sql).toContain(`"persona"."handle" IS NOT NULL`);
    expect(sql).toContain(`"persona"."visibility" IN ('open', 'network')`);
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM "content_moderation"');
    expect(sql).toContain(`"subject_type" = 'subprofile'`);
    expect(sql).toContain(`"subject_id" = "persona"."id"::text`);
    expect(sql).toContain(`"hidden_at" IS NOT NULL OR`);
    expect(sql).toContain(`"removed_at" IS NOT NULL)`);
    expect(sql).toContain('EXISTS (SELECT 1 FROM "users"');
    expect(sql).toContain(`"status" = 'active'`);
    expect(sql).toContain(`= "persona"."user_id"`);
  });

  it('shows anonymous viewers open unlinked personas alone', () => {
    expect(anonymousVisiblePersonaSql('persona')).toBe(
      `"persona"."visibility" = 'open' AND "persona"."link_visibility" <> 'linked'`,
    );
  });

  it('checks a block in both directions against the given column', () => {
    const sql = notBlockedEitherWaySql('$2', '"persona"."user_id"');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM "blocks"');
    expect(sql).toContain(
      `"blocker_id" = $2 AND "team_block"."blocked_id" = "persona"."user_id"`,
    );
    expect(sql).toContain(
      `"blocker_id" = "persona"."user_id" AND "team_block"."blocked_id" = $2`,
    );
  });

  it('requires an active, open, unhidden, untaken member', () => {
    const sql = eligibleMemberSql('member_profile', 'member_user');
    expect(sql).toContain(`"member_user"."status" = 'active'`);
    expect(sql).toContain(`"member_profile"."visibility" = 'open'`);
    expect(sql).toContain(
      `("member_profile"."hidden_until" IS NULL OR "member_profile"."hidden_until" <= now())`,
    );
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM "content_moderation"');
    expect(sql).toContain(`"subject_type" = 'member'`);
    expect(sql).toContain(
      `"subject_id" IN ("member_profile"."slug", "member_profile"."user_id"::text)`,
    );
    expect(sql).toContain(`"hidden_at" IS NOT NULL OR`);
    expect(sql).toContain(`"removed_at" IS NOT NULL)`);
    expect(MEMBER_MODERATION_SUBJECT_TYPE).toBe('member');
  });

  it('adds the public profile switch for anonymous viewers', () => {
    const sql = anonymousVisibleMemberSql('member_profile', 'member_user');
    expect(
      sql.startsWith(eligibleMemberSql('member_profile', 'member_user')),
    ).toBe(true);
    expect(sql).toContain('EXISTS (SELECT 1 FROM "member_preferences"');
    expect(sql).toContain(`"user_id" = "member_profile"."user_id"`);
    expect(sql).toContain(`"public_profile_enabled" = true`);
  });

  it('checks the member did not hide from the viewer', () => {
    const sql = notHiddenFromViewerSql('$2', '"member_profile"."user_id"');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM "hidden_from_members"');
    expect(sql).toContain(`"owner_id" = "member_profile"."user_id"`);
    expect(sql).toContain(`"hidden_from_user_id" = $2`);
  });

  it('treats a live, shown, untaken listing as public', () => {
    const sql = publiclyVisibleListingSql('listing');
    expect(sql).toContain(`"listing"."status" = 'live'`);
    expect(sql).toContain(`"listing"."is_hidden_by_owner" = false`);
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM "content_moderation"');
    expect(sql).toContain(`IN ('business', 'listing')`);
    expect(sql).toContain(`"subject_id" = "listing"."slug"`);
    expect(LISTING_MODERATION_SUBJECT_TYPES).toEqual(['business', 'listing']);
  });

  it('leaves the 18+ category out', () => {
    expect(notAdultListingSql('listing')).toBe(
      `NOT ('intimacy' = ANY("listing"."cats"))`,
    );
  });

  it('uses alias-scoped inner names', () => {
    const innerAliases = (sql: string): string[] =>
      [...sql.matchAll(/(?:FROM "[a-z_]+") "([a-z_]+)"/g)].flatMap((match) =>
        match[1] === undefined ? [] : [match[1]],
      );
    const firstAliases = innerAliases(eligiblePersonaSql('first'));
    const secondAliases = innerAliases(eligiblePersonaSql('second'));
    expect(firstAliases.length).toBeGreaterThan(0);
    expect(secondAliases.length).toBe(firstAliases.length);
    for (const alias of firstAliases) {
      expect(secondAliases).not.toContain(alias);
    }
    const firstMemberAliases = innerAliases(
      anonymousVisibleMemberSql('first', 'first_user'),
    );
    const secondMemberAliases = innerAliases(
      anonymousVisibleMemberSql('second', 'second_user'),
    );
    expect(firstMemberAliases.length).toBe(2);
    expect(secondMemberAliases.length).toBe(2);
    for (const alias of firstMemberAliases) {
      expect(secondMemberAliases).not.toContain(alias);
    }
  });
});
