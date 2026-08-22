// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The generation counter behind a card's permanent code.
 *
 * Defaults to 1 and is NOT NULL, so every card already issued keeps a valid
 * code the moment this lands. Raising it is how an issuer voids a physical
 * card that was lost or stolen without revoking the member's digital card, a
 * distinction that did not exist while codes expired after sixty seconds.
 *
 * Integer rather than smallint: the token carries a uint16, and matching the
 * column to that width would make the first overflow a database error instead
 * of the guarded 400 `MembershipCardsService.replaceCode` returns.
 */
export class AddMembershipCardCodeVersion1793760000000 implements MigrationInterface {
  name = 'AddMembershipCardCodeVersion1793760000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "membership_cards" ADD "code_version" integer NOT NULL DEFAULT 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "membership_cards" DROP COLUMN "code_version"`,
    );
  }
}
