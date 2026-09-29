// Lives in `src/database`, outside `src/migrations`: the TypeORM CLI and
// `DatabaseModule` both require every `src/migrations/*.ts` file, and
// requiring a spec there throws `describe is not defined` before any
// migration runs. Same convention as
// `repair-legacy-caption-edits-migration.spec.ts`.
import {
  LEGACY_CATEGORY_TO_FIELD,
  LEGACY_COMMITMENT_TO_ID,
  LEGACY_SENIORITY_TO_ID,
  PROFESSION_MOVES,
  REMAINING_PROFESSIONS_BY_OLD_FIELD,
  mapColumnSql,
  profileMoveSql,
} from './work-taxonomy-migration.sql';

describe('work taxonomy migration', () => {
  it('maps every posted and seeded category label', () => {
    expect(LEGACY_CATEGORY_TO_FIELD).toMatchObject({
      'legal & admin': 'legal',
      'design & creative': 'design',
      'tech & engineering': 'tech',
      'writing & editing': 'editorial',
      translation: 'languages',
      'teaching & tutoring': 'education',
      'health & wellbeing': 'healthcare',
      design: 'design',
      engineering: 'engineering',
      'community & advocacy': 'community',
      'programme & operations': 'operations',
      retail: 'retail',
    });
    expect(LEGACY_CATEGORY_TO_FIELD).not.toHaveProperty('other');
    expect(LEGACY_CATEGORY_TO_FIELD).not.toHaveProperty('practical help');
  });

  it('maps commitment and seniority labels, including the seed Junior', () => {
    expect(LEGACY_COMMITMENT_TO_ID['freelance / gig']).toBe('freelanceGig');
    expect(LEGACY_SENIORITY_TO_ID.junior).toBe('entry');
    expect(LEGACY_SENIORITY_TO_ID['lead / principal']).toBe('leadPrincipal');
  });

  it('builds a CASE that keeps ids, maps labels case-insensitively and falls back', () => {
    const sql = mapColumnSql(
      '"category"',
      { 'design & creative': 'design' },
      ['design'],
      null,
    );
    expect(sql).toContain(`WHEN "category" IN ('design') THEN "category"`);
    expect(sql).toContain(
      `WHEN lower(trim("category")) = 'design & creative' THEN 'design'`,
    );
    expect(sql).toContain('ELSE NULL');
  });

  it('adds the new field and drops the old one only when nothing else holds it', () => {
    const statements = profileMoveSql();
    const joined = statements.join('\n');
    expect(PROFESSION_MOVES).toHaveLength(19);
    expect(joined).toContain(`array_append("discipline", 'security')`);
    expect(joined).toContain(`array_remove("discipline", 'retail')`);
    // The retail removal is guarded by the professions that stay in retail.
    expect(joined).toContain(`'shopAssistant'`);
    expect(REMAINING_PROFESSIONS_BY_OLD_FIELD.retail).toEqual([
      'shopAssistant',
      'florist',
      'bookseller',
      'storeManager',
      'visualMerchandiser',
    ]);
  });

  it('keeps operations for a profile whose receptionist arrived from retail', () => {
    const statements = profileMoveSql();
    const dropOperations = statements.find((statement) =>
      statement.includes(`array_remove("discipline", 'operations')`),
    );
    expect(dropOperations).toBeDefined();
    const notGuard = dropOperations?.match(/NOT \(.*&&.*\)/)?.[0];
    expect(notGuard).toContain(`'receptionist'`);
    expect(REMAINING_PROFESSIONS_BY_OLD_FIELD.operations).toContain(
      'receptionist',
    );
  });
});
