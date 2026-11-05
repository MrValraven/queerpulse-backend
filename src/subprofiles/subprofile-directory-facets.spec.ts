import { buildTagVocabularySql } from './subprofile-directory-facets';
import { visibleSectionSql } from './subprofile-visible-sections-sql';

describe('buildTagVocabularySql', () => {
  it('joins each tagged item to its persona and keeps visible sections only', () => {
    const sql = buildTagVocabularySql('SELECT 1', '$1', '$2', '$3');
    expect(sql).toContain(
      'INNER JOIN "subprofiles" "tag_persona" ON "tag_persona"."id" = "tag_item"."subprofile_id"',
    );
    expect(sql).toContain(
      visibleSectionSql('"tag_item"."section"', '"tag_persona"."kind"', '$2'),
    );
    expect(sql).toContain('LIMIT $3');
  });
});
