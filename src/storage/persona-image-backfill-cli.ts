// DO NOT RUN: authored for review only. The maintainer runs it once, after
// migration 1830080000000-AddPersonaStorageKeys has been applied.
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { SubprofileLinkVisibility } from '../subprofiles/entities/subprofile.entity';
import { toBareKey } from './bare-key';
import { PersonaImageKeysService } from './persona-image-keys.service';
import { storageKeyOwnerId } from './storage-key';

/**
 * T17: one-off re-homing of images on personas that were ALREADY unlinked
 * before persona-scoped keys existed.
 *
 * From T17 on, an unlink copies every image the persona references to a
 * persona-scoped key (`persona/<uuid>/<uuid><ext>`) that names nobody, and
 * every later image write to an unlinked persona does the same. Personas
 * unlinked before that still show images keyed `<prefix>/<userId>/…`, whose
 * URL names the member behind the pseudonym. This walks every unlinked
 * persona and runs the same re-home the unlink runs
 * (`PersonaImageKeysService.rehomeUnlinkedPersona`, `backfill` mode):
 * avatar, cover, item images and feed show art. Item revisions are left as
 * they are; a restore onto an unlinked persona re-homes its image.
 *
 * A persona that changed gets its `edit_version` raised by 1, so an editor
 * open on the old image keys is told the persona moved on (the 409
 * `PERSONA_EDIT_CONFLICT`) and reloads before it saves again.
 *
 * WHY A CLI RATHER THAN A MIGRATION. The work is bucket copies, which a
 * migration cannot do, and migrations run automatically at boot.
 *
 * SAFETY
 *   - Read-only by default: it reports how many member-scoped references each
 *     unlinked persona holds. `--apply` performs the copies and rewrites.
 *   - Idempotent: a persona-scoped key is never copied again, so a second run
 *     (or a run interrupted halfway) only finishes what is left.
 *   - Each persona is re-homed in its own transaction, under its row lock,
 *     the lock every persona editor write takes, so an edit in flight is
 *     never overwritten.
 *   - Nothing is deleted. The member-scoped originals stay in the bucket
 *     (the named persona already published them); the orphan sweep reclaims
 *     them once nothing references them.
 *
 * USAGE (from queerpulse-backend/)
 *   npx ts-node -r tsconfig-paths/register src/storage/persona-image-backfill-cli.ts
 *   npx ts-node -r tsconfig-paths/register src/storage/persona-image-backfill-cli.ts --apply
 */

const APPLY_FLAG = '--apply';

interface PersonaRow {
  id: string;
  avatar_url: string | null;
  cover_url: string | null;
}

/** How many references on one persona still carry a member id. */
async function countMemberScopedReferences(
  dataSource: DataSource,
  persona: PersonaRow,
): Promise<number> {
  const rows: { value: string }[] = await dataSource.query(
    `SELECT "image_url" AS "value" FROM "subprofile_items"
      WHERE "subprofile_id" = $1 AND "image_url" IS NOT NULL
     UNION ALL
     SELECT "image_key" AS "value" FROM "subprofile_feeds"
      WHERE "subprofile_id" = $1 AND "image_key" IS NOT NULL`,
    [persona.id],
  );
  return [
    persona.avatar_url,
    persona.cover_url,
    ...rows.map((row) => row.value),
  ]
    .filter((value): value is string => Boolean(value))
    .filter((value) => storageKeyOwnerId(toBareKey(value)) !== null).length;
}

async function main(): Promise<void> {
  const isApplying = process.argv.includes(APPLY_FLAG);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const dataSource = app.get(DataSource);
    const personaImageKeys = app.get(PersonaImageKeysService);
    const personas: PersonaRow[] = await dataSource.query(
      `SELECT "id", "avatar_url", "cover_url" FROM "subprofiles"
        WHERE "link_visibility" = $1
        ORDER BY "id"`,
      [SubprofileLinkVisibility.Unlinked],
    );

    let affectedPersonaCount = 0;
    let referenceCount = 0;
    let rehomedCount = 0;
    for (const persona of personas) {
      const pendingCount = await countMemberScopedReferences(
        dataSource,
        persona,
      );
      if (pendingCount === 0) {
        continue;
      }
      affectedPersonaCount += 1;
      referenceCount += pendingCount;
      if (!isApplying) {
        console.log(
          `${persona.id}: ${pendingCount} member-scoped reference(s)`,
        );
        continue;
      }
      try {
        const rehomed = await dataSource.transaction(async (manager) => {
          const locked: PersonaRow[] = await manager.query(
            `SELECT "id", "avatar_url", "cover_url" FROM "subprofiles"
              WHERE "id" = $1 AND "link_visibility" = $2
              FOR UPDATE`,
            [persona.id, SubprofileLinkVisibility.Unlinked],
          );
          const current = locked[0];
          if (!current) {
            // Linked or deleted since the scan: nothing to do.
            return new Map<string, string | null>();
          }
          const rehomedKeys = await personaImageKeys.rehomeUnlinkedPersona(
            manager,
            {
              id: current.id,
              avatarUrl: current.avatar_url,
              coverUrl: current.cover_url,
            },
            'backfill',
          );
          if (rehomedKeys.size > 0) {
            await manager.query(
              `UPDATE "subprofiles" SET "edit_version" = "edit_version" + 1 WHERE "id" = $1`,
              [current.id],
            );
          }
          return rehomedKeys;
        });
        rehomedCount += rehomed.size;
        console.log(`${persona.id}: re-homed ${rehomed.size} key(s)`);
      } catch (error) {
        // One persona failing (a bucket hiccup) must not stop the rest; a
        // re-run picks it up.
        console.error(`${persona.id}: failed, re-run to retry`, error);
        process.exitCode = 1;
      }
    }

    console.log(
      isApplying
        ? `Re-homed ${rehomedCount} key(s) across ${affectedPersonaCount} unlinked persona(s).`
        : `${referenceCount} member-scoped reference(s) on ${affectedPersonaCount} of ${personas.length} unlinked persona(s). Run with ${APPLY_FLAG} to re-home them.`,
    );
  } finally {
    await app.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
