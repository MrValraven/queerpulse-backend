// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Takes the invented `community-privacy` guide prose out of `resources`.
 *
 * `BackfillResourceGuides1794833210000` seeded this row with sections that
 * describe a "coming-out space" running on "reduced visibility by default",
 * a member list "not shown to other members", and moderators who "never see
 * your wider QueerPulse activity". The backend enforces none of that: only the
 * `private` access tier is hidden from outsiders, members of a community can
 * see its roster, accessTier has no default (the creator picks it), and
 * nothing limits what a moderator reads beyond the community's own screens.
 * The owner has ruled that nothing invented may appear on a public page, and
 * the hardcoded `CommunityPrivacyPage` has been rewritten to state only what
 * the code enforces. But `ManagedGuide` serves the database `sections` instead
 * of the hardcoded page once a row is published AND review-stamped, so the
 * invented prose would still reach readers. This migration removes it.
 * `RemoveInventedGuideProse1839700000000` deliberately left this slug alone;
 * this migration finishes the job.
 *
 * Two guarded changes, same technique as 1839700000000:
 *
 *  1. Card copy: `description` and `description_pt` are swapped to the new
 *     text, one column at a time, and only while the column still holds the
 *     exact text the backfill wrote. The new text equals
 *     `communityPrivacy.meta.description` in the frontend catalogs. `title`
 *     and `title_pt` carry no invented claim and are left alone.
 *
 *  2. Prose: `sections` becomes `[]`, `sections_pt` becomes NULL and `body`
 *     becomes the (already corrected) `description`. An empty `sections` makes
 *     the frontend fall back to the hardcoded page, which still renders with
 *     the row's review footer. The guard is a MARKER: one exact sentence of
 *     the seeded English sections that is itself an invented claim. The row is
 *     touched only while `sections::text` still contains it. Any edit through
 *     the admin editor rewrites `sections`, so an editor-authored row no
 *     longer carries the marker and is never matched. Running again finds no
 *     marker and changes nothing.
 *
 * The review stamp (`last_reviewed_on`, `reviewed_by`) is kept, so the guide
 * stays public and reads from the hardcoded page.
 *
 * The seeded and replacement strings are written out here on purpose, so this
 * migration does not depend on whatever the frontend catalogs say on the day
 * it runs. A migration file exports only its class: TypeORM would `new` any
 * exported function.
 */
interface GuideCopySwap {
  column: 'description' | 'description_pt';
  from: string;
  to: string;
}

const SLUG = 'community-privacy';

/** One exact sentence of the seeded English sections that is an invented claim. */
const INVENTED_PROSE_MARKER =
  'Your membership of the coming-out space is never shown publicly';

const COPY_SWAPS: GuideCopySwap[] = [
  {
    column: 'description',
    from: 'How visibility works on QueerPulse by default: what shows on your public profile, inside the community, and to the moderation team, and how to change it.',
    to: 'What a private community hides from people outside it, what its members can see, and what stays off your profile.',
  },
  {
    column: 'description_pt',
    from: 'Como funciona a visibilidade por predefinição na QueerPulse: o que aparece no teu perfil público, dentro da comunidade e para a equipa de moderação.',
    to: 'O que uma comunidade privada esconde de quem está fora dela, o que as pessoas que lá estão conseguem ver e o que fica fora do teu perfil.',
  },
];

export class RemoveInventedCommunityPrivacyProse1839800000000 implements MigrationInterface {
  name = 'RemoveInventedCommunityPrivacyProse1839800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Card copy first, so the `body = description` below copies corrected text.
    for (const swap of COPY_SWAPS) {
      await queryRunner.query(
        `UPDATE "resources" SET "${swap.column}" = $1 WHERE "slug" = $2 AND "${swap.column}" = $3`,
        [swap.to, SLUG, swap.from],
      );
    }

    // `strpos` rather than LIKE: the marker holds no wildcard characters, but
    // this does not depend on that staying true.
    await queryRunner.query(
      `UPDATE "resources"
          SET "sections" = '[]'::jsonb,
              "sections_pt" = NULL,
              "body" = "description"
        WHERE "slug" = $1
          AND strpos("sections"::text, $2) > 0`,
      [SLUG, INVENTED_PROSE_MARKER],
    );
  }

  public async down(): Promise<void> {
    // Deliberately a no-op. Restoring the seeded sections and card copy would
    // republish prose about a "coming-out space", reduced visibility by
    // default and moderator limits that the backend does not enforce, which is
    // the bug `up` fixes.
  }
}
