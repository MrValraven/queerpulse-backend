import { KIND_SECTIONS } from './subprofile-kinds';
import {
  VISIBLE_SECTIONS_BY_KIND_JSON,
  visibleSectionSql,
} from './subprofile-visible-sections-sql';

describe('subprofile-visible-sections-sql', () => {
  it('lists every kind with its sections plus gallery and links', () => {
    const visibleSectionsByKind = JSON.parse(
      VISIBLE_SECTIONS_BY_KIND_JSON,
    ) as Record<string, string[]>;
    expect(Object.keys(visibleSectionsByKind).sort()).toEqual(
      Object.keys(KIND_SECTIONS).sort(),
    );
    expect(visibleSectionsByKind.musician).toEqual([
      'discography',
      'gigs',
      'gallery',
      'links',
    ]);
    for (const sections of Object.values(visibleSectionsByKind)) {
      expect(sections).toEqual(expect.arrayContaining(['gallery', 'links']));
    }
  });

  it('builds the jsonb containment predicate with the named parameter by default', () => {
    expect(visibleSectionSql('"item"."section"', '"sp"."kind"')).toBe(
      '(CAST(:visibleSectionsByKind AS jsonb) -> ("sp"."kind")::text) @> to_jsonb(("item"."section")::text)',
    );
  });

  it('accepts a positional parameter for raw queries', () => {
    expect(
      visibleSectionSql('"tag_item"."section"', '"tag_persona"."kind"', '$3'),
    ).toContain('CAST($3 AS jsonb)');
  });
});
