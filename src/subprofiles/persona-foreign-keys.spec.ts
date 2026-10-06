import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CascadePersonaIdUpdates1830060000000,
  PERSONA_FOREIGN_KEYS,
} from '../migrations/1830060000000-CascadePersonaIdUpdates';

/**
 * ENG-447: an unlink re-keys the persona row and its items with a single
 * `UPDATE ... SET "id"` each, which only works while every foreign key to
 * `subprofiles.id` and `subprofile_items.id` cascades on update. The
 * migration that adds the cascade checks the catalog when it runs; this
 * reads the migrations themselves, so a foreign key added later without the
 * cascade fails here, before any deploy.
 */

const MIGRATIONS_DIRECTORY = join(__dirname, '..', 'migrations');
const CASCADE_MIGRATION_PREFIX = '1830060000000-';
const REKEYED_TABLES = ['subprofiles', 'subprofile_items'];

interface DeclaredForeignKey {
  table: string;
  constraintName: string;
  column: string;
  references: string;
  actions: string;
  migration: string;
}

/** The `up` half of a migration: a `down` re-creates keys as they were. */
function upBodyOf(source: string): string {
  const downStart = source.indexOf('public async down(');
  return downStart === -1 ? source : source.slice(0, downStart);
}

/** The table the statement at `position` alters or creates. */
function tableAt(source: string, position: number): string {
  const tablePattern = /(?:ALTER|CREATE) TABLE (?:IF NOT EXISTS )?"(\w+)"/g;
  let table = '';
  for (const match of source.matchAll(tablePattern)) {
    if ((match.index ?? 0) > position) break;
    table = match[1] ?? '';
  }
  return table;
}

/** Every foreign key to a re-keyed table, as its latest `up` declares it. */
function declaredForeignKeys(): Map<string, DeclaredForeignKey> {
  const foreignKeyPattern =
    /CONSTRAINT\s+"([^"]+)"\s+FOREIGN KEY\s*\(\s*"([^"]+)"\s*\)\s*REFERENCES\s+"(\w+)"\s*\(\s*"id"\s*\)((?:\s+ON (?:DELETE|UPDATE) (?:CASCADE|SET NULL|SET DEFAULT|NO ACTION|RESTRICT))*)/g;
  const declared = new Map<string, DeclaredForeignKey>();
  const migrationFiles = readdirSync(MIGRATIONS_DIRECTORY)
    .filter(
      (file) =>
        file.endsWith('.ts') && !file.startsWith(CASCADE_MIGRATION_PREFIX),
    )
    .sort();
  for (const migration of migrationFiles) {
    const upBody = upBodyOf(
      readFileSync(join(MIGRATIONS_DIRECTORY, migration), 'utf8'),
    );
    for (const match of upBody.matchAll(foreignKeyPattern)) {
      const [, constraintName, column, references, actions] = match;
      if (!constraintName || !column || !references) continue;
      if (!REKEYED_TABLES.includes(references)) continue;
      declared.set(constraintName, {
        table: tableAt(upBody, match.index ?? 0),
        constraintName,
        column,
        references,
        actions: (actions ?? '').replace(/\s+/g, ' ').trim(),
        migration,
      });
    }
  }
  return declared;
}

/** How many times the migrations name a re-keyed table in a REFERENCES. */
function referenceCount(): number {
  const referencePattern = /REFERENCES\s+"(subprofiles|subprofile_items)"/g;
  return readdirSync(MIGRATIONS_DIRECTORY)
    .filter(
      (file) =>
        file.endsWith('.ts') && !file.startsWith(CASCADE_MIGRATION_PREFIX),
    )
    .map(
      (file) =>
        [
          ...readFileSync(join(MIGRATIONS_DIRECTORY, file), 'utf8').matchAll(
            referencePattern,
          ),
        ].length,
    )
    .reduce((total, count) => total + count, 0);
}

function namedForeignKeyCount(): number {
  const namedPattern =
    /CONSTRAINT\s+"[^"]+"\s+FOREIGN KEY\s*\(\s*"[^"]+"\s*\)\s*REFERENCES\s+"(subprofiles|subprofile_items)"/g;
  return readdirSync(MIGRATIONS_DIRECTORY)
    .filter(
      (file) =>
        file.endsWith('.ts') && !file.startsWith(CASCADE_MIGRATION_PREFIX),
    )
    .map(
      (file) =>
        [
          ...readFileSync(join(MIGRATIONS_DIRECTORY, file), 'utf8').matchAll(
            namedPattern,
          ),
        ].length,
    )
    .reduce((total, count) => total + count, 0);
}

describe('persona foreign keys cascade on update (ENG-447)', () => {
  // An unnamed inline REFERENCES would slip past the name-based checks below.
  it('finds a named constraint for every REFERENCES to a re-keyed table', () => {
    expect(referenceCount()).toBeGreaterThan(0);
    expect(namedForeignKeyCount()).toBe(referenceCount());
  });

  it('names every foreign key the migrations declare to a re-keyed table, or that key cascades on its own', () => {
    const listedNames = new Set(
      PERSONA_FOREIGN_KEYS.map(({ constraintName }) => constraintName),
    );
    const uncovered = [...declaredForeignKeys().values()]
      .filter(
        ({ constraintName, actions }) =>
          !listedNames.has(constraintName) &&
          !actions.includes('ON UPDATE CASCADE'),
      )
      .map(
        ({ migration, constraintName }) => `${migration}: ${constraintName}`,
      );

    expect(uncovered).toEqual([]);
  });

  it('matches each listed key to its declaration: table, column, target and ON DELETE', () => {
    const declared = declaredForeignKeys();

    for (const listed of PERSONA_FOREIGN_KEYS) {
      const declaration = declared.get(listed.constraintName);
      expect(declaration).toMatchObject({
        table: listed.table,
        column: listed.column,
        references: listed.references,
      });
      expect(declaration?.actions).toContain(`ON DELETE ${listed.onDelete}`);
    }
  });

  // ENG-447: a block carried across a persona going unlinked names the
  // persona, and must follow it to the fresh id the unlink gives it. Declared
  // by a later migration (1830070000000), so it is not in the re-create list.
  it('cascades the carried identity block key to the persona on update and delete', () => {
    expect(
      declaredForeignKeys().get('FK_identity_blocks_blocked_subprofile'),
    ).toMatchObject({
      table: 'identity_blocks',
      column: 'blocked_subprofile_id',
      references: 'subprofiles',
      actions: 'ON DELETE CASCADE ON UPDATE CASCADE',
    });
  });

  it('lists each key once', () => {
    const names = PERSONA_FOREIGN_KEYS.map(
      ({ constraintName }) => constraintName,
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it('re-creates every listed key with ON UPDATE CASCADE', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: (sql: string) => {
        statements.push(sql.replace(/\s+/g, ' ').trim());
        return Promise.resolve();
      },
    };

    await new CascadePersonaIdUpdates1830060000000().up(
      queryRunner as unknown as Parameters<
        CascadePersonaIdUpdates1830060000000['up']
      >[0],
    );

    for (const listed of PERSONA_FOREIGN_KEYS) {
      expect(statements).toContain(
        `ALTER TABLE "${listed.table}" ADD CONSTRAINT "${listed.constraintName}" ` +
          `FOREIGN KEY ("${listed.column}") REFERENCES "${listed.references}"("id") ` +
          `ON DELETE ${listed.onDelete} ON UPDATE CASCADE`,
      );
    }
  });
});

describe('persona entity relations cascade on update (ENG-447)', () => {
  /** Every `*.entity.ts` under `src`. */
  function entityFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) return entityFiles(entryPath);
      return entry.name.endsWith('.entity.ts') ? [entryPath] : [];
    });
  }

  // The decorator carries the same rule, so a generated migration never
  // proposes dropping the cascade.
  it('gives every relation to a persona or its item onUpdate CASCADE', () => {
    const relationPattern =
      /@ManyToOne\(\s*\(\)\s*=>\s*(?:Subprofile|SubprofileItem)\b\s*(?:,\s*\{([^}]*)\})?/g;
    const missing: string[] = [];
    let relationCount = 0;
    for (const file of entityFiles(join(__dirname, '..'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(
        relationPattern,
      )) {
        relationCount += 1;
        if (!/onUpdate:\s*'CASCADE'/.test(match[1] ?? '')) missing.push(file);
      }
    }

    expect(relationCount).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
