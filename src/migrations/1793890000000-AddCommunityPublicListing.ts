import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `communities.is_publicly_listed`: the owner's opt-in to a signed-out teaser
 * of their community.
 *
 * The policy this column encodes, stated precisely so the surfaces built on it
 * cannot drift from it:
 *
 * 1. It is the OWNER's decision alone. Platform staff do not set it, and no
 *    automatic path sets it.
 * 2. It DEFAULTS TO FALSE. Shipping this feature exposes nothing that was
 *    private yesterday; a community becomes findable only by someone choosing
 *    to make it findable.
 * 3. It is only MEANINGFUL for the `public` and `request` access tiers. An
 *    `invite` or `private` community with the flag on still shows a signed-out
 *    visitor nothing, because being findable is incompatible with those tiers
 *    by definition.
 * 4. A listed community exposes a LIMITED teaser and nothing beyond it: name,
 *    tagline, purpose, tags, member COUNT, and the next public gathering.
 * 5. It NEVER exposes the roster (no names, no avatars, no who-is-who) and
 *    NEVER exposes a single post, reply or reaction. Those stay behind the
 *    door for every tier, listed or not.
 *
 * The signed-out response builder is the one place that boundary is drawn, so
 * every field added to the community DTO later is opt-in there rather than
 * inherited into the public teaser by default.
 *
 * NOT NULL with a constant default, so `ADD COLUMN` is metadata-only and every
 * existing community lands on the safe side of the switch.
 */
export class AddCommunityPublicListing1793890000000 implements MigrationInterface {
  name = 'AddCommunityPublicListing1793890000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "is_publicly_listed" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "is_publicly_listed"`,
    );
  }
}
