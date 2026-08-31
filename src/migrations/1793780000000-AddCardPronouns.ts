import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pronouns on a membership card, as a pair of switches rather than a stored
 * value.
 *
 * The pronouns themselves already live on `profiles.pronouns` and are read
 * from there at the response boundary, so a member who updates them updates
 * every card they hold at once and no card can go stale against its holder.
 * What these two columns record is only whether a given card prints them.
 *
 * `community_cards.allows_pronouns` is the ISSUING community's decision, the
 * same shape as `allows_member_photo`, and defaults to false: shipping this
 * feature must not add a line to cards people already hold.
 *
 * `membership_cards.is_pronouns_hidden` is the HOLDER's veto over their own
 * card, the same shape as `is_photo_hidden`, and defaults to false so that a
 * community which switches pronouns on gets the card it designed while anyone
 * for whom that is the wrong thing to hand a stranger can opt out per card.
 */
export class AddCardPronouns1793780000000 implements MigrationInterface {
  name = 'AddCardPronouns1793780000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_cards" ADD "allows_pronouns" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "membership_cards" ADD "is_pronouns_hidden" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "membership_cards" DROP COLUMN "is_pronouns_hidden"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_cards" DROP COLUMN "allows_pronouns"`,
    );
  }
}
