// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPartnerFeaturedAndTestimonial1785000130000 implements MigrationInterface {
  name = 'AddPartnerFeaturedAndTestimonial1785000130000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "partners" ADD "featured" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "partners" ADD "testimonial_quote" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "partners" ADD "testimonial_author" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "partners" ADD "testimonial_role" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "partners" DROP COLUMN "testimonial_role"`,
    );
    await queryRunner.query(
      `ALTER TABLE "partners" DROP COLUMN "testimonial_author"`,
    );
    await queryRunner.query(
      `ALTER TABLE "partners" DROP COLUMN "testimonial_quote"`,
    );
    await queryRunner.query(`ALTER TABLE "partners" DROP COLUMN "featured"`);
  }
}
