// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `community_invites`: the durable half of a community invitation (PRD-140,
 * PRD-141).
 *
 * WHY THE TABLE EXISTS. `CommunityInvitesService.invite` used to send a
 * notification and write nothing, which left the two tiers an invitation is
 * for with no way to honour one. A `private` community 404s every non-member
 * from both `getBySlug` and `join`, so an invitee tapped the bell and was
 * redirected to `/communities` with no explanation and the community stayed a
 * roster of one; an `invite` community accepted an ordinary join request from
 * anybody at all, so the tier sold as "only people you've invited can get in"
 * behaved exactly like `request`. A pending row here is now what those two
 * tiers gate on. See `CommunityInvite`'s docstring for the full contract, and
 * note that nothing here adds anybody to `community_members`: the invitee
 * still joins through the front door and consents for themselves.
 *
 * ONE PENDING INVITE PER (community, member), enforced by the partial unique
 * index `UQ_community_invites_pending` (`WHERE status = 'pending'`) —
 * `UQ_community_join_requests_pending`'s idiom, and what makes a re-invite
 * idempotent under a race between two moderators pressing send at once. It is
 * partial so that declining or revoking an invitation does not bar the
 * community from ever inviting that person again.
 *
 * FK behaviour. `community_id` and `invited_user_id` CASCADE: a deleted
 * community has nobody to admit, and an erased account cannot accept. The two
 * ACTOR columns are nullable and `ON DELETE SET NULL`
 * (`community_bans.banned_by_user_id`'s convention): a moderator leaving must
 * not withdraw the invitations they sent, nor rewrite the record of a
 * revocation.
 *
 * TRANSACTIONAL, and safely so. `CREATE TYPE` here is a NEW type rather than
 * an `ALTER TYPE ... ADD VALUE` on an existing one, so the non-transactional
 * rule those files opt out for does not apply, and every index builds on a
 * table created empty in the same transaction, so none needs `CONCURRENTLY`.
 */
export class CreateCommunityInvites1799000000000 implements MigrationInterface {
  name = 'CreateCommunityInvites1799000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "community_invites_status_enum" AS ENUM
        ('pending', 'accepted', 'declined', 'revoked')
    `);
    await queryRunner.query(`
      CREATE TABLE "community_invites" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "community_id" uuid NOT NULL,
        "invited_user_id" uuid NOT NULL,
        "invited_by_user_id" uuid,
        "status" "community_invites_status_enum" NOT NULL DEFAULT 'pending',
        "responded_at" TIMESTAMP WITH TIME ZONE,
        "revoked_by_user_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_community_invites" PRIMARY KEY ("id"),
        CONSTRAINT "FK_community_invites_community"
          FOREIGN KEY ("community_id")
          REFERENCES "communities"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_community_invites_invited_user"
          FOREIGN KEY ("invited_user_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_community_invites_invited_by"
          FOREIGN KEY ("invited_by_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_community_invites_revoked_by"
          FOREIGN KEY ("revoked_by_user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    // The gate, read on every `getBySlug` and `join` of a private or
    // invite-tier community: "does THIS caller hold a pending invite here?".
    // Leading with the community keeps it usable for the moderator-facing
    // list below as well.
    await queryRunner.query(`
      CREATE INDEX "IDX_community_invites_community_status_created_at"
        ON "community_invites" ("community_id", "status", "created_at" DESC, "id" DESC)
    `);
    // "What have I been invited to?" — `GET /me/community-invites`, and the
    // per-community lookup above reversed for a member with invitations from
    // several communities at once.
    await queryRunner.query(`
      CREATE INDEX "IDX_community_invites_invited_user_status"
        ON "community_invites" ("invited_user_id", "status", "created_at" DESC, "id" DESC)
    `);
    // The rule the idempotent re-invite path rests on. See the doc comment.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_community_invites_pending"
        ON "community_invites" ("community_id", "invited_user_id")
        WHERE "status" = 'pending'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "community_invites"`);
    await queryRunner.query(`DROP TYPE "community_invites_status_enum"`);
  }
}
