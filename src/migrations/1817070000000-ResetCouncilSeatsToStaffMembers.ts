import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DO NOT RUN: authored for review only; the maintainer runs migrations.
 *
 * Advisory-council seats now name a platform staff member (`memberId`) instead
 * of carrying a typed-in `name` + `initials` pair, and the reader resolves that
 * person's name and face from their profile.
 *
 * `governance_overview.council` is `jsonb`, so there is no DDL here — only the
 * stored documents, which are in the old shape and cannot be converted: the
 * four seats this table shipped with are hand-written names of people who have
 * no account on the platform, so there is no member id to point them at. They
 * are cleared, and an admin appoints seat-holders from the staff roster on the
 * Policy tab. The public council section renders its own empty state until then
 * rather than showing seats with nobody behind them.
 *
 * `down()` restores those four seeded seats. It is deliberately NOT a
 * round-trip of whatever was in the column: this migration destroys the old
 * shape, and pretending otherwise would be worse than restoring the documented
 * starting point.
 */
export class ResetCouncilSeatsToStaffMembers1817070000000 implements MigrationInterface {
  name = 'ResetCouncilSeatsToStaffMembers1817070000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "governance_overview" SET "council" = '[]'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "governance_overview" SET "council" = $1::jsonb`,
      [
        JSON.stringify([
          {
            name: 'Mariana Loução',
            initials: 'ML',
            roleKey: 'psychologistChair',
            tint: 'jade',
          },
          {
            name: 'Raquel Baptista',
            initials: 'RB',
            roleKey: 'lawyerLegalAdvisor',
            tint: 'violet',
          },
          {
            name: 'Catarina Vaz',
            initials: 'CV',
            roleKey: 'housingActivist',
            tint: 'plum',
          },
          {
            name: 'Jonas Ferreira',
            initials: 'JF',
            roleKey: 'healthcareAdvocate',
            tint: 'jade',
          },
        ]),
      ],
    );
  }
}
