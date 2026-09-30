import { type SelectQueryBuilder } from 'typeorm';
import {
  BIO_SEARCHABLE_CLAUSE,
  HOOD_VISIBLE_CLAUSE,
  applyDirectoryFilters,
  countDirectoryFacets,
  memberSearchIds,
  memberSearchRank,
  memberSearchTextMatch,
  zeroedFacetCounts,
  type DirectoryFacetGroup,
} from './member-directory.query';
import { AMBASSADOR_FOCUS_AREAS } from '../ambassadors/ambassador-focus-areas';
import {
  NOT_BADGED_STAFF_PARAMETERS,
  notBadgedStaffClause,
} from '../ambassadors/ambassador-status.service';
import { DIRECTORY_IDENTITY_FACETS } from './identities';
import { NEIGHBOURHOODS } from './neighbourhoods';
import { LANGUAGE_CODES } from './languages';
import { OPEN_TO_PRESET_IDS } from './open-to';
import { LISTED_DISCIPLINE_IDS } from './professions';
import {
  PROFILE_PUBLIC_SEARCH_COLUMNS,
  PROFILE_PUBLIC_SEARCH_FIELDS,
  foldedHaystack,
  foldedSearchTerm,
  weightedSearchVector,
} from '../search/search-text';

/** The accent-folded neighbourhood match the hood filter and counts bind. */
const locationMatches = (parameterName: string): string =>
  `${foldedHaystack('p', ['location'])} LIKE ${foldedSearchTerm(parameterName)} ESCAPE '\\'`;

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
    setParameters: (values: Record<string, unknown>) => {
      Object.assign(parameters, values);
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
    ['hoods', locationMatches('hood0')],
    ['disciplines', 'p.discipline && :disciplines'],
    ['professions', 'p.profession && :professions'],
    ['languages', 'p.languages && :languages'],
  ])('skips only the %s predicate', (group, fragment) => {
    const query = {
      identities: 'lesbian',
      openTo: 'mentoring',
      hoods: 'Anjos',
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

  it('keeps the search term in every count query', () => {
    const spy = qbSpy();
    applyDirectoryFilters(spy.qb, { query: 'sao' }, 'openTo');
    const sql = spy.sql();
    // A count answers "how many of MY results", and the search term is part
    // of what makes them the member's. It is not a counted facet group, so
    // unlike hoods above it survives every skip.
    expect(sql).toContain('websearch_to_tsquery');
  });

  describe('searching by profession and field of work', () => {
    /** The one predicate the search term produced, with its parameters. */
    function searchCall(spy: ReturnType<typeof qbSpy>): WhereCall {
      const found = spy.calls.find(([text]) =>
        text.includes('websearch_to_tsquery'),
      );
      expect(found).toBeDefined();
      return found!;
    }

    it('ORs the profession and discipline ids into the search group', () => {
      const spy = qbSpy();
      applyDirectoryFilters(spy.qb, {
        query: 'nurse',
        searchProfessions: 'nurse,gp',
        searchDisciplines: 'healthcare',
      });
      const [predicate, parameters] = searchCall(spy);
      // One parenthesised group, so a member matches on name/bio OR on what
      // they do, and the whole group still ANDs with every other filter.
      expect(predicate.startsWith('(')).toBe(true);
      expect(predicate.endsWith(')')).toBe(true);
      expect(predicate).toContain(
        ' OR p.profession && :memberSearchProfessions',
      );
      expect(predicate).toContain(
        ' OR p.discipline && :memberSearchDisciplines',
      );
      expect(parameters).toMatchObject({
        memberSearchTerm: 'nurse',
        memberSearchPattern: '%nurse%',
        memberSearchProfessions: ['nurse', 'gp'],
        memberSearchDisciplines: ['healthcare'],
      });
    });

    it('binds its own parameter names beside the exact chip filters', () => {
      const spy = qbSpy();
      applyDirectoryFilters(spy.qb, {
        query: 'nurse',
        searchProfessions: 'nurse',
        professions: 'gp',
      });
      const [, parameters] = searchCall(spy);
      expect(parameters).toMatchObject({ memberSearchProfessions: ['nurse'] });
      // The chip filter keeps its own AND predicate and its own parameter.
      expect(spy.calls).toContainEqual([
        'p.profession && :professions',
        { professions: ['gp'] },
      ]);
    });

    it('drops unknown ids and keeps the known ones', () => {
      const spy = qbSpy();
      applyDirectoryFilters(spy.qb, {
        query: 'nurse',
        searchProfessions: 'sorcerer,nurse',
      });
      const [, parameters] = searchCall(spy);
      expect(parameters?.memberSearchProfessions).toEqual(['nurse']);
    });

    it('adds no branch when every id is unknown', () => {
      const spy = qbSpy();
      applyDirectoryFilters(spy.qb, {
        query: 'nurse',
        searchProfessions: 'sorcerer',
        searchDisciplines: 'alchemy',
      });
      const [predicate, parameters] = searchCall(spy);
      expect(predicate).not.toContain('memberSearchProfessions');
      expect(predicate).not.toContain('memberSearchDisciplines');
      expect(parameters).not.toHaveProperty('memberSearchProfessions');
      expect(parameters).not.toHaveProperty('memberSearchDisciplines');
      // An unknown search id only fails to widen the search. It is part of
      // the term, so it never empties the directory the way an unknown chip
      // filter id does.
      expect(spy.sql()).not.toContain('1 = 0');
    });

    it('ignores the search ids when there is no search term', () => {
      const spy = qbSpy();
      applyDirectoryFilters(spy.qb, {
        searchProfessions: 'nurse',
        searchDisciplines: 'healthcare',
      });
      expect(spy.calls).toHaveLength(0);
    });

    it.each<DirectoryFacetGroup>(['professions', 'disciplines', 'openTo'])(
      'keeps the search branch in the %s count query',
      (group) => {
        const spy = qbSpy();
        applyDirectoryFilters(
          spy.qb,
          {
            query: 'nurse',
            searchProfessions: 'nurse',
            searchDisciplines: 'healthcare',
          },
          group,
        );
        const [predicate] = searchCall(spy);
        expect(predicate).toContain('p.profession && :memberSearchProfessions');
        expect(predicate).toContain('p.discipline && :memberSearchDisciplines');
      },
    );
  });

  // ENG-439: the card shows a neighbourhood only for an `open` profile whose
  // member left `hoodVisible` on, so the filter must not match anyone else,
  // or ticking one neighbourhood at a time sorts the hiders into theirs.
  it('matches a neighbourhood only where the card would show it', () => {
    const spy = qbSpy();
    applyDirectoryFilters(spy.qb, { hoods: 'Anjos,Arroios' });
    const found = spy.calls.find(([text]) => text.includes('"p"."location"'));
    expect(found).toBeDefined();
    const [predicate, parameters] = found!;
    expect(HOOD_VISIBLE_CLAUSE).toContain(`"p"."visibility" = 'open'`);
    expect(HOOD_VISIBLE_CLAUSE).toContain('"p"."hood_visible" = true');
    expect(predicate).toBe(
      `(${HOOD_VISIBLE_CLAUSE} AND (${locationMatches('hood0')} OR ${locationMatches('hood1')}))`,
    );
    expect(parameters).toEqual({ hood0: '%Anjos%', hood1: '%Arroios%' });
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

  describe('ambassador filter', () => {
    it('adds the visible-tag gate and an active-ambassador EXISTS for ambassador=1', () => {
      const spy = qbSpy();
      applyDirectoryFilters(spy.qb, { ambassador: '1' });
      const sql = spy.sql();
      expect(sql).toContain('p.is_ambassador_tag_visible = true');
      expect(sql).toContain('FROM "ambassadors" "amb"');
      expect(sql).toContain('"amb"."revoked_at" IS NULL');
    });

    it('narrows by focus_area inside the same EXISTS when focus is given', () => {
      const spy = qbSpy();
      applyDirectoryFilters(spy.qb, {
        ambassador: '1',
        focus: 'housing,youth',
      });
      const found = spy.calls.find(([text]) =>
        text.includes('FROM "ambassadors"'),
      );
      expect(found).toBeDefined();
      const [predicate, parameters] = found!;
      expect(predicate).toContain(
        '"amb"."focus_area" IN (:...ambassadorFocusAreas)',
      );
      expect(parameters).toEqual({
        ...NOT_BADGED_STAFF_PARAMETERS,
        ambassadorFocusAreas: ['housing', 'youth'],
      });
    });

    it('keeps a staff ambassador out of the filter (staff always win)', () => {
      const spy = qbSpy();
      applyDirectoryFilters(spy.qb, { ambassador: '1' });
      const found = spy.calls.find(([text]) =>
        text.includes('FROM "ambassadors"'),
      );
      const [predicate, parameters] = found!;
      expect(predicate).toContain(notBadgedStaffClause('"p"."user_id"'));
      expect(parameters).toEqual(
        expect.objectContaining(NOT_BADGED_STAFF_PARAMETERS),
      );
    });

    it('ignores focus when ambassador is not set', () => {
      const spy = qbSpy();
      applyDirectoryFilters(spy.qb, { focus: 'housing,youth' });
      expect(spy.calls).toHaveLength(0);
    });

    it('drops unknown focus keys', () => {
      const spy = qbSpy();
      applyDirectoryFilters(spy.qb, {
        ambassador: '1',
        focus: 'housing,sorcery',
      });
      const found = spy.calls.find(([text]) =>
        text.includes('FROM "ambassadors"'),
      );
      const [, parameters] = found!;
      expect(parameters).toEqual({
        ...NOT_BADGED_STAFF_PARAMETERS,
        ambassadorFocusAreas: ['housing'],
      });
    });

    it('omits the focus_area clause when every focus key is unknown', () => {
      const spy = qbSpy();
      applyDirectoryFilters(spy.qb, { ambassador: '1', focus: 'sorcery' });
      const found = spy.calls.find(([text]) =>
        text.includes('FROM "ambassadors"'),
      );
      const [predicate, parameters] = found!;
      expect(predicate).not.toContain('focus_area');
      expect(parameters).toEqual(NOT_BADGED_STAFF_PARAMETERS);
    });

    it('is omitted entirely when skip is ambassador', () => {
      const spy = qbSpy();
      applyDirectoryFilters(
        spy.qb,
        { ambassador: '1', focus: 'housing' },
        'ambassador',
      );
      expect(spy.calls).toHaveLength(0);
    });
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
    for (const id of LISTED_DISCIPLINE_IDS)
      expect(counts.disciplines[id]).toBe(0);
    for (const id of LANGUAGE_CODES) expect(counts.languages[id]).toBe(0);
    for (const id of NEIGHBOURHOODS) expect(counts.hoods[id]).toBe(0);
    // The "All of Lisbon" row is chrome, not a place, so it is absent from
    // `NEIGHBOURHOODS` — but it is a row in the sidebar and so must still be
    // counted, or it would render with no badge beside seven that have one.
    expect(counts.hoods['All of Lisbon']).toBe(0);
    expect(Object.keys(counts.professions).length).toBeGreaterThan(0);
    for (const focusArea of AMBASSADOR_FOCUS_AREAS)
      expect(counts.ambassador[focusArea]).toBe(0);
  });

  it('gives each group its own builder with its own group skipped', async () => {
    const asked: (DirectoryFacetGroup | undefined)[] = [];
    await countDirectoryFacets((skip) => {
      asked.push(skip);
      return qbSpy().qb;
    });
    expect(asked.sort()).toEqual(
      [
        'ambassador',
        'disciplines',
        'hoods',
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
    // Hoods bind a LIKE pattern, the same folded substring test the filter uses.
    expect(spies.get('hoods')!.parameters.facetOption0).toBe(
      `%${NEIGHBOURHOODS[0]}%`,
    );
    // …and the last row, "All of Lisbon", binds the pattern that matches
    // everyone: it is the "no hood restriction" row, so its count is the whole
    // population rather than any one neighbourhood's.
    expect(
      spies.get('hoods')!.parameters[`facetOption${NEIGHBOURHOODS.length}`],
    ).toBe('%');
    // Ambassador binds one clause per focus-area key, each carrying the
    // visible-tag gate and the same active-ambassador EXISTS the filter uses.
    expect(spies.get('ambassador')!.selects).toHaveLength(
      AMBASSADOR_FOCUS_AREAS.length,
    );
    expect(spies.get('ambassador')!.parameters.facetOption0).toBe(
      AMBASSADOR_FOCUS_AREAS[0],
    );
  });

  // ENG-439: a hidden neighbourhood adds to no count, so the badges cannot be
  // diffed into the filter the predicate above closes.
  it('counts a neighbourhood only where the card would show it', async () => {
    const spies = new Map<DirectoryFacetGroup, ReturnType<typeof qbSpy>>();
    await countDirectoryFacets((skip) => {
      const spy = qbSpy();
      spies.set(skip, spy);
      return spy.qb;
    });
    const hoodSelects = spies.get('hoods')!.selects;
    expect(hoodSelects).toHaveLength(NEIGHBOURHOODS.length + 1);
    NEIGHBOURHOODS.forEach((_, index) =>
      expect(hoodSelects[index]![0]).toContain(HOOD_VISIBLE_CLAUSE),
    );
    // "All of Lisbon" counts the whole hood-unrestricted population, which
    // places nobody, so it keeps counting everyone.
    expect(hoodSelects[NEIGHBOURHOODS.length]![0]).not.toContain(
      HOOD_VISIBLE_CLAUSE,
    );
  });

  it('leaves staff ambassadors out of every focus-area count', async () => {
    const spies = new Map<DirectoryFacetGroup, ReturnType<typeof qbSpy>>();
    await countDirectoryFacets((skip) => {
      const spy = qbSpy();
      spies.set(skip, spy);
      return spy.qb;
    });
    const ambassadorSpy = spies.get('ambassador')!;
    for (const [clauseSql] of ambassadorSpy.selects)
      expect(clauseSql).toContain(notBadgedStaffClause('"p"."user_id"'));
    expect(ambassadorSpy.parameters).toEqual(
      expect.objectContaining(NOT_BADGED_STAFF_PARAMETERS),
    );
  });
});

describe('zeroedFacetCounts', () => {
  it('covers every counted group', () => {
    expect(Object.keys(zeroedFacetCounts()).sort()).toEqual([
      'ambassador',
      'disciplines',
      'hoods',
      'identities',
      'languages',
      'openTo',
      'professions',
    ]);
  });

  // A member can select "sex work & adult content", but iterating the full
  // taxonomy here would give it a facet-count key, which is itself a way to
  // learn how many members picked it. See professions.ts#UNLISTED_DISCIPLINE_IDS.
  it('has no adultWork/sexWorker keys, and does have lifeStage/student', () => {
    const counts = zeroedFacetCounts();
    expect(counts.disciplines).not.toHaveProperty('adultWork');
    expect(counts.professions).not.toHaveProperty('sexWorker');
    expect(counts.disciplines).toHaveProperty('lifeStage');
    expect(counts.professions).toHaveProperty('student');
  });
});

describe('memberSearchIds', () => {
  it('drops an unlisted profession id so it can never widen a search', () => {
    expect(
      memberSearchIds({
        query: 'nurse',
        searchProfessions: 'sexWorker,nurse',
      }),
    ).toEqual({
      searchProfessions: ['nurse'],
      searchDisciplines: [],
    });
  });

  it('drops an unlisted discipline id the same way', () => {
    expect(
      memberSearchIds({
        query: 'nurse',
        searchDisciplines: 'adultWork,healthcare',
      }),
    ).toEqual({
      searchProfessions: [],
      searchDisciplines: ['healthcare'],
    });
  });
});

// ENG-438: a `network`/`private` member's bio sits behind the limited card, so
// member search must not match or rank on it.
describe('bio-gated member search', () => {
  /** The second branch: every row whose bio the viewer cannot read. */
  function hiddenBioBranch(sql: string): string {
    const marker = `OR (NOT ${BIO_SEARCHABLE_CLAUSE} AND`;
    const index = sql.indexOf(marker);
    expect(index).toBeGreaterThan(-1);
    return sql.slice(index);
  }

  it('gates the bio columns behind an open profile', () => {
    expect(BIO_SEARCHABLE_CLAUSE).toBe(`"p"."visibility" = 'open'`);
    const sql = memberSearchTextMatch();
    // The open branch keeps both bios in the index-backed expressions.
    expect(sql.startsWith(`(${BIO_SEARCHABLE_CLAUSE} AND (`)).toBe(true);
    expect(sql).toContain('"p"."bio_pt"');
    // Every other row matches on name, handle and short bio only.
    const hidden = hiddenBioBranch(sql);
    expect(hidden).toContain('"p"."first_name"');
    expect(hidden).toContain('"p"."tagline"');
    expect(hidden).not.toContain('"p"."bio"');
    expect(hidden).not.toContain('"p"."bio_pt"');
  });

  // `1824900000000-AddProfilePublicSearchIndexes` backs this branch with
  // partial indexes `WHERE "visibility" <> 'open'`. The planner proves that
  // predicate from the literal gate below, and matches the index on the exact
  // expressions `search-text.spec.ts` pins against the migration.
  it('keeps the hidden-bio branch on its partial indexes', () => {
    const hidden = hiddenBioBranch(memberSearchTextMatch());
    expect(hidden.startsWith(`OR (NOT "p"."visibility" = 'open' AND (`)).toBe(
      true,
    );
    expect(hidden).toContain(
      `${weightedSearchVector('p', PROFILE_PUBLIC_SEARCH_FIELDS)} @@ `,
    );
    expect(hidden).toContain(
      `${foldedHaystack('p', PROFILE_PUBLIC_SEARCH_COLUMNS)} LIKE `,
    );
  });

  it('applies the gated match as the directory search predicate', () => {
    const spy = qbSpy();
    applyDirectoryFilters(spy.qb, { query: 'ana -word' });
    const found = spy.calls.find(([text]) =>
      text.includes('websearch_to_tsquery'),
    );
    expect(found![0]).toBe(`(${memberSearchTextMatch()})`);
  });

  it('ranks a hidden-bio row without its bio', () => {
    const rank = memberSearchRank();
    expect(rank.startsWith(`(CASE WHEN ${BIO_SEARCHABLE_CLAUSE} THEN`)).toBe(
      true,
    );
    const elseBranch = rank.slice(rank.indexOf(' ELSE '));
    expect(elseBranch).toContain('"p"."first_name"');
    expect(elseBranch).not.toContain('"p"."bio"');
    expect(elseBranch).not.toContain('"p"."bio_pt"');
    // It binds the raw term only, like the ordering it replaces.
    expect(rank).not.toContain(':memberSearchPattern');
  });
});
