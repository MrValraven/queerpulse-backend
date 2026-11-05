import {
  bindRefinementParameters,
  tagsOverlapClause,
} from './subprofile-directory-refinement';
import {
  VISIBLE_SECTIONS_BY_KIND_JSON,
  visibleSectionSql,
} from './subprofile-visible-sections-sql';

describe('subprofile directory refinement', () => {
  it('matches tags only on items in sections the persona kind shows', () => {
    expect(tagsOverlapClause('refineTags')).toContain(
      visibleSectionSql('"tag_item"."section"', '"sp"."kind"'),
    );
  });

  it('binds the visible-sections map with the other refinement parameters', () => {
    const queryBuilder = { setParameter: jest.fn() };
    bindRefinementParameters(queryBuilder as never);
    expect(queryBuilder.setParameter).toHaveBeenCalledWith(
      'visibleSectionsByKind',
      VISIBLE_SECTIONS_BY_KIND_JSON,
    );
  });
});
