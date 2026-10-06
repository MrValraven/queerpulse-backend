import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Brings two guides' library copy in line with what their pages now show.
 * This copy renders on the live /resources library card and feeds search.
 *
 *  - `intersectionality` (PRD-451): the page's member quotes were invented
 *    and now render in demo mode only, so "member voices" becomes "context".
 *  - `sexual-health` (DES-421): the copy promised free PrEP through the SNS,
 *    which now holds only on the hospital route, and a community-reviewed
 *    clinic directory, a claim the page no longer makes. It now matches the
 *    page's corrected meta description.
 *
 * Each column is updated on its own and only while it still holds the exact
 * text `BackfillResourceGuides1794833210000` wrote, so an editor's later
 * change to any of them is left alone. The backfill used each guide's English
 * description as its body too. `down()` mirrors the guard and restores the
 * backfill text.
 */
interface GuideCopySwap {
  slug: string;
  column: 'description' | 'description_pt' | 'body';
  from: string;
  to: string;
}

const INTERSECTIONALITY_OLD =
  'How race, faith, class, and disability intersect with queerness in Lisbon: member voices and resources for people navigating more than one identity at once.';
const INTERSECTIONALITY_OLD_PT =
  'Como raça, fé, classe e deficiência se cruzam com a identidade queer em Lisboa: vozes de membros e recursos para quem vive mais do que uma identidade ao mesmo tempo.';
const INTERSECTIONALITY_NEW =
  'How race, faith, class, and disability intersect with queerness in Lisbon: context and resources for people navigating more than one identity at once.';
const INTERSECTIONALITY_NEW_PT =
  'Como raça, fé, classe e deficiência se cruzam com a identidade queer em Lisboa: contexto e recursos para quem vive mais do que uma identidade ao mesmo tempo.';

const SEXUAL_HEALTH_OLD =
  'A practical guide to sexual health in Lisbon: where to get tested, how to access free PrEP through the SNS, HIV resources and U=U, and a community-reviewed clinic directory.';
const SEXUAL_HEALTH_OLD_PT =
  'Um guia prático de saúde sexual em Lisboa: onde fazer testes, como aceder à PrEP gratuita pelo SNS, recursos sobre VIH e I=I, e um diretório de clínicas avaliado pela comunidade.';
const SEXUAL_HEALTH_NEW =
  'A practical guide to sexual health in Lisbon: where to get tested, how to access PrEP through the SNS, and HIV resources including U=U.';
const SEXUAL_HEALTH_NEW_PT =
  'Um guia prático de saúde sexual em Lisboa: onde fazer testes, como aceder à PrEP pelo SNS e recursos sobre VIH, incluindo I=I.';

const SWAPS: GuideCopySwap[] = [
  {
    slug: 'intersectionality',
    column: 'description',
    from: INTERSECTIONALITY_OLD,
    to: INTERSECTIONALITY_NEW,
  },
  {
    slug: 'intersectionality',
    column: 'description_pt',
    from: INTERSECTIONALITY_OLD_PT,
    to: INTERSECTIONALITY_NEW_PT,
  },
  {
    slug: 'intersectionality',
    column: 'body',
    from: INTERSECTIONALITY_OLD,
    to: INTERSECTIONALITY_NEW,
  },
  {
    slug: 'sexual-health',
    column: 'description',
    from: SEXUAL_HEALTH_OLD,
    to: SEXUAL_HEALTH_NEW,
  },
  {
    slug: 'sexual-health',
    column: 'description_pt',
    from: SEXUAL_HEALTH_OLD_PT,
    to: SEXUAL_HEALTH_NEW_PT,
  },
  {
    slug: 'sexual-health',
    column: 'body',
    from: SEXUAL_HEALTH_OLD,
    to: SEXUAL_HEALTH_NEW,
  },
];

export class RefreshGuideLibraryCopy1828740000000 implements MigrationInterface {
  name = 'RefreshGuideLibraryCopy1828740000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const swap of SWAPS) {
      await queryRunner.query(
        `UPDATE "resources" SET "${swap.column}" = $1 WHERE "slug" = $2 AND "${swap.column}" = $3`,
        [swap.to, swap.slug, swap.from],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const swap of SWAPS) {
      await queryRunner.query(
        `UPDATE "resources" SET "${swap.column}" = $1 WHERE "slug" = $2 AND "${swap.column}" = $3`,
        [swap.from, swap.slug, swap.to],
      );
    }
  }
}
