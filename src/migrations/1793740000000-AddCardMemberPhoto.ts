// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets a membership card carry the holder's photo, under two switches rather
 * than one.
 *
 * `community_cards.allows_member_photo` is the programme's: whether these
 * cards are photo cards at all. It defaults to FALSE, so no card that already
 * exists starts showing a face because this migration ran.
 *
 * `membership_cards.is_photo_hidden` is the member's veto on their own card,
 * honoured even where the programme has photos on. It defaults to FALSE so a
 * member of a photo-card community gets the card the community designed, and
 * a member who does not want their face on a credential naming an LGBTQ+
 * community can turn it off without leaving.
 *
 * Neither column stores an image. The photo is the holder's existing
 * `profiles.avatar_url`, resolved at the response boundary only when both
 * switches allow it, so there is one avatar per member and turning the card
 * photo off deletes nothing.
 */
export class AddCardMemberPhoto1793740000000 implements MigrationInterface {
  name = 'AddCardMemberPhoto1793740000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_cards" ADD "allows_member_photo" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "membership_cards" ADD "is_photo_hidden" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "membership_cards" DROP COLUMN "is_photo_hidden"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_cards" DROP COLUMN "allows_member_photo"`,
    );
  }
}
