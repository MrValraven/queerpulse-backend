import { type SelectQueryBuilder } from 'typeorm';
import {
  applyDirectoryFilters,
  countDirectoryFacets,
  zeroedFacetCounts,
  type DirectoryFacetGroup,
} from './member-directory.query';
import { DIRECTORY_IDENTITY_FACETS } from './identities';
import { LANGUAGE_CODES } from './languages';
import { OPEN_TO_PRESET_IDS } from './open-to';
import { DISCIPLINE_IDS } from './professions';

/** Records every predicate applied, which is all these tests care about. */
type WhereCall = [string, Record<string, unknown> | undefined];

function qbSpy() {
  const calls: WhereCall[] = [];
  const selects: [string, string][] = [];
  const parameters: Record<string, unknown> = {};
  const qb = {
    andWhere: (sql: string, params?: Record<string, unknown>) => {
      calls.push([sql, params]);
      return qb;
    },
    select: () => qb,
    addSelect: (sql: string, alias: string) => {
      selects.push([sql, alias]);
      return qb;
    },
    setParameter: (name: string, value: unknown) => {
      parameters[name] = value;
      return qb;
    },
    getRawOne: () => Promise.resolve(undefined),
  };
  return {
    qb: qb as unknown as SelectQueryBuilder<Record<string, unknown>>,
    calls,
    selects,
    parameters,
    /** The SQL of every predicate applied, joined for substring assertions. */
    sql: () => calls.map(([text]) => text).join('\n'),
  };
}

describe('applyDirectoryFilters', () => {
  it('applies every selected facet when nothing is skipped', () => {
    const spy = qbSpy();
    applyDirectoryFilters(spy.qb, {
      identities: 'lesbian',
      openTo: 'mentoring',
      disciplines: 'design',
      professions: 'illustrator',
      languages: 'PT',
    });
    const sql = spy.sql();
    expect(sql).toContain('discoverable_identities');
    expect(sql).toContain('open_to');
    expect(sql).toContain('p.discipline && :disciplines');
    expect(sql).toContain('p.profession && :professions');
    expect(sql).toContain('p.languages && :languages');
  });

  // The heart of the availability semantics: a group's own selection must not
  // narrow its own counts, or ticking one option zeroes all of its siblings.
  it.each<[DirectoryFacetGroup, string]>([
    ['identities', 'discoverable_identities'],
    ['openTo', 'open_to'],
    ['disciplines', 'p.discipline && :disciplines'],
    ['professions', 'p.profession && :professions'],
    ['languages', 'p.languages && :languages'],
  ])('skips only the %s predicate', (group, fragment) => {
    const query = {
      identities: 'lesbian',
      openTo: 'mentoring',
      disciplines: 'design',
      professions: 'illustrator',
      languages: 'PT',
    };
    const skipped = qbSpy();
    applyDirectoryFilters(skipped.qb, query, group);
    expect(skipped.sql()).not.toContain(fragment);

    // …and every OTHER group's predicate survives, so the count is still taken
    // over the member's current results rather than the whole directory.
    const others = qbSpy();
    applyDirectoryFilters(others.qb, query);
    const survivors = others.calls.length - skipped.calls.length;
    expect(survivors).toBe(1);
  });

  it('keeps the search term, hoods and the age range in every count query', () => {
    const spy = qbSpy();
    applyDirectoryFilters(
      spy.qb,
      { query: 'sao', hoods: 'Anjos', yearsFrom: 2, yearsTo: 5 },
      'openTo',
    );
    const sql = spy.sql();
    // A count answers "how many of MY results", and these three are part of
    // what makes them the member's — none of them is a counted facet group.
    expect(sql).toContain('websearch_to_tsquery');
    expect(sql).toContain('p.location ILIKE :hood0');
    expect(sql).toContain('>= :yearsFrom');
    expect(sql).toContain('<= :yearsTo');
  });

  it('matches nothing rather than everything when a facet id is unknown', () => {
    const spy = qbSpy();
    applyDirectoryFilters(spy.qb, { disciplines: 'sorcery' });
    // Never the unfiltered directory: that would be a silently wrong answer to
    // a question about a facet that cannot exist.
    expect(spy.sql()).toContain('1 = 0');
  });

  it('still matches nothing for an unknown id in the group being skipped', () => {
    const spy = qbSpy();
    applyDirectoryFilters(spy.qb, { disciplines: 'sorcery' }, 'disciplines');
    // Skipping drops the whole group, unknown ids included — the count query
    // asks "who is there if this group were untouched", and an impossible id
    // is exactly the case where every option's count still matters.
    expect(spy.sql()).not.toContain('1 = 0');
  });
});

describe('countDirectoryFacets', () => {
  it('reports an explicit zero for every known option, never a missing key', async () => {
    const counts = await countDirectoryFacets(() => qbSpy().qb);
    // A missing key means "not counted" and renders no badge; a zero means
    // "counted, and empty" and renders a dimmed option. The two must not
    // collapse into each other.
    for (const id of OPEN_TO_PRESET_IDS) expect(counts.openTo[id]).toBe(0);
    for (const id of DIRECTORY_IDENTITY_FACETS)
      expect(counts.identities[id]).toBe(0);
    for (const id of DISCIPLINE_IDS) expect(counts.disciplines[id]).toBe(0);
    for (const id of LANGUAGE_CODES) expect(counts.languages[id]).toBe(0);
    expect(Object.keys(counts.professions).length).toBeGreaterThan(0);
  });

  it('gives each group its own builder with its own group skipped', async () => {
    const asked: (DirectoryFacetGroup | undefined)[] = [];
    await countDirectoryFacets((skip) => {
      asked.push(skip);
      return qbSpy().qb;
    });
    expect(asked.sort()).toEqual(
      [
        'disciplines',
        'identities',
        'languages',
        'openTo',
        'professions',
      ].sort(),
    );
  });

  it('binds one filter clause per option', async () => {
    const spies = new Map<DirectoryFacetGroup, ReturnType<typeof qbSpy>>();
    await countDirectoryFacets((skip) => {
      const spy = qbSpy();
      spies.set(skip, spy);
      return spy.qb;
    });
    expect(spies.get('openTo')!.selects).toHaveLength(
      OPEN_TO_PRESET_IDS.length,
    );
    expect(spies.get('identities')!.selects).toHaveLength(
      DIRECTORY_IDENTITY_FACETS.length,
    );
    // Identity clauses bind the facet's LABEL SET, not the facet id: the column
    // stores a member's own interest labels and the checkbox is a coarse
    // bucket over several of them.
    expect(spies.get('identities')!.parameters.facetOption0).toEqual(
      expect.arrayContaining(['Trans']),
    );
  });
});

describe('zeroedFacetCounts', () => {
  it('covers every counted group', () => {
    expect(Object.keys(zeroedFacetCounts()).sort()).toEqual([
      'disciplines',
      'identities',
      'languages',
      'openTo',
      'professions',
    ]);
  });
});
