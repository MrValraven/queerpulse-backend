import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The spec's guard for "spaces never appear in a listing": every
 * community-listing query in these files keeps spaces out through
 * `topLevelOnly(...)` or `TOP_LEVEL_WHERE` (`./subcommunity-rules`).
 *
 * Two counts per file, both read from the source with imports and comments
 * stripped:
 *
 *  - `helperUses`: calls of `topLevelOnly(` plus uses of `TOP_LEVEL_WHERE`.
 *    Dropping one from an existing query fails here.
 *  - `communityQuerySites`: places that read the `communities` table
 *    (repository reads, query builders over `Community`, and raw SQL naming
 *    `"communities"`). Adding a new one fails here until someone checks
 *    whether it lists communities to a person, applies the helper when it
 *    does, and updates both counts together.
 *
 * Some sites are single-community lookups by id or slug that need no helper,
 * which is why the two counts differ. The point is that neither changes
 * without a deliberate look at this file.
 */
const EXPECTED_COUNTS: Record<
  string,
  { helperUses: number; communityQuerySites: number }
> = {
  'communities/communities.service.ts': {
    helperUses: 5,
    communityQuerySites: 10,
  },
  'landing/landing.service.ts': { helperUses: 1, communityQuerySites: 1 },
  'member-suggestions/member-suggestions.service.ts': {
    helperUses: 1,
    communityQuerySites: 1,
  },
  'profiles/profiles.service.ts': { helperUses: 3, communityQuerySites: 2 },
  'admin-communities/admin-communities.service.ts': {
    helperUses: 1,
    communityQuerySites: 7,
  },
  'admin-members/admin-members.service.ts': {
    helperUses: 2,
    communityQuerySites: 2,
  },
  'admin-trust-network/admin-trust-network.service.ts': {
    helperUses: 1,
    communityQuerySites: 1,
  },
  'roadmap/roadmap-vote-breakdown.util.ts': {
    helperUses: 1,
    communityQuerySites: 1,
  },
  'press-kit/press-kit.service.ts': { helperUses: 1, communityQuerySites: 1 },
  'profiles/activity-visibility.service.ts': {
    helperUses: 1,
    communityQuerySites: 1,
  },
  'feature-usage/admin-feature-usage.service.ts': {
    helperUses: 1,
    communityQuerySites: 1,
  },
};

const IMPORT_DECLARATION = /^import[\s\S]*?from\s+['"][^'"]+['"];/gm;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
// `(?<!:)` keeps a `https://` inside a string literal intact.
const LINE_COMMENT = /(?<!:)\/\/.*/g;
const HELPER_USE = /\btopLevelOnly\(|\bTOP_LEVEL_WHERE\b/g;
const COMMUNITY_QUERY_SITE =
  /\bcommunities\.(?:find|findAndCount|count|createQueryBuilder)\(|\b(?:createQueryBuilder|from|innerJoin|leftJoin|find|count|getRepository)\(\s*Community\b|['"]communities['"]/g;

function codeOf(relativePath: string): string {
  const source = readFileSync(join(__dirname, '..', relativePath), 'utf8');
  return source
    .replace(IMPORT_DECLARATION, '')
    .replace(BLOCK_COMMENT, '')
    .replace(LINE_COMMENT, '');
}

describe('topLevelOnly guard (spaces stay out of listings)', () => {
  it.each(Object.entries(EXPECTED_COUNTS))(
    '%s keeps its top-level filters and query sites',
    (relativePath, expected) => {
      const code = codeOf(relativePath);

      expect({
        helperUses: code.match(HELPER_USE)?.length ?? 0,
        communityQuerySites: code.match(COMMUNITY_QUERY_SITE)?.length ?? 0,
      }).toEqual(expected);
    },
  );

  it('reads real files, so a zero can never pass by accident', () => {
    for (const relativePath of Object.keys(EXPECTED_COUNTS)) {
      expect(codeOf(relativePath).length).toBeGreaterThan(0);
    }
  });
});
