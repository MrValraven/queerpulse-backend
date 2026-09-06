// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-165: adds `draft.meta`, the composer state a draft needs to reopen
 * exactly where the member left it.
 *
 * The forum's new-thread composer autosaves through `/me/drafts`, but the
 * table's columns only carried the title and the body. Everything else the
 * member had already chosen (the category, the community they were posting to,
 * the tags, and the photo they attached) was kept in that browser's
 * `localStorage`, because `CreateDraftDto` runs under `forbidNonWhitelisted`
 * and there was nowhere on the server to put it.
 *
 * That made a server feature quietly device-local: a post started on a phone
 * and reopened on a laptop came back as a body with the other four silently
 * gone, and nothing on screen said so. Members do not think of a saved draft as
 * belonging to a browser.
 *
 * One nullable `jsonb` bag rather than four forum columns. `/me/drafts` is
 * shared by job applications, magazine pitches, grant applications and forum
 * posts, and bolting one composer's fields onto every other kind's table would
 * be paid for again by the next composer. Each surface owns the keys it writes
 * and ignores the ones it does not know, like a query string.
 *
 * Separate from the existing `payload` jsonb for two reasons: `payload` is the
 * drafts-LIST view-model that `DraftsService.update` merges field by field,
 * while `meta` is private to the composer and must be replaced wholesale (a
 * removed tag has to disappear); and keeping them apart lets either evolve
 * without re-reading the other's merge rules.
 *
 * Bounded before it is ever written: `@IsDraftMeta` refuses anything that is
 * not a flat object of strings, numbers, booleans, nulls or string arrays, caps
 * the key count and each key and value, and holds the serialized payload under
 * 8 KB. A column an autosave rewrites every 1.5 seconds, open to every active
 * member, is otherwise free object storage. Only a REFERENCE to an uploaded
 * photo is stored here; the bytes stay in the bucket.
 *
 * Purely additive: a nullable column with no default and no backfill, so no
 * existing draft row is read or rewritten, and drafts already saved in a
 * browser keep working (the frontend still writes that copy as a same-session
 * fallback and prefers the server's when both exist). No index: `meta` is never
 * filtered or ordered on, only read alongside the row it belongs to.
 */
export class AddDraftComposerMeta1808000000000 implements MigrationInterface {
  name = 'AddDraftComposerMeta1808000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "draft" ADD COLUMN "meta" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "draft" DROP COLUMN "meta"`);
  }
}
