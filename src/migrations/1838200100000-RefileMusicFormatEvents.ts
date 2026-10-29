// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Re-files the five music formats into the `music` family: club night,
 * listening party and karaoke leave `party`, jam session leaves `make`, and
 * live performance leaves `watch`.
 *
 * Each statement matches the format key AND its own old family, so a karaoke
 * event a host filed under `meet` stays where it is. `format_details` stays as
 * stored: the music family allows every key a moved format held (the jam
 * session keeps `bring` through the format exception), so nothing needs
 * stripping. `down` sends each key back to the family it came from.
 *
 * The table below is a frozen copy on purpose. A migration is history, so it
 * does not import the live format catalogue, which is free to change later.
 * Runs after `AddMusicGatheringFamily1838200000000`, in its own transaction,
 * because Postgres refuses a new enum label in the transaction that added it.
 */
const MUSIC_FORMAT_KEYS_BY_OLD_FAMILY: readonly {
  readonly oldFamily: string;
  readonly formatKeys: readonly string[];
}[] = [
  {
    oldFamily: 'party',
    formatKeys: ['club-night', 'listening-party', 'karaoke'],
  },
  { oldFamily: 'make', formatKeys: ['jam-session'] },
  { oldFamily: 'watch', formatKeys: ['live-performance'] },
];

function quotedList(formatKeys: readonly string[]): string {
  return formatKeys.map((formatKey) => `'${formatKey}'`).join(', ');
}

export class RefileMusicFormatEvents1838200100000 implements MigrationInterface {
  name = 'RefileMusicFormatEvents1838200100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const { oldFamily, formatKeys } of MUSIC_FORMAT_KEYS_BY_OLD_FAMILY) {
      await queryRunner.query(
        `UPDATE "events" SET "gathering_family" = 'music' WHERE "gathering_family" = '${oldFamily}' AND "event_type" IN (${quotedList(formatKeys)})`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const { oldFamily, formatKeys } of MUSIC_FORMAT_KEYS_BY_OLD_FAMILY) {
      await queryRunner.query(
        `UPDATE "events" SET "gathering_family" = '${oldFamily}' WHERE "gathering_family" = 'music' AND "event_type" IN (${quotedList(formatKeys)})`,
      );
    }
  }
}
