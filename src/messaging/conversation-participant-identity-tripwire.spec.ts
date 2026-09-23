import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * F2 (C2, C3): `conversation_participants.identity_id` is NOT NULL, and
 * every mocked spec that covers a seat write mocks the repository, so a seat
 * insert that forgets the identity passes its own tests and fails in
 * production. This tripwire reads every non-spec source file under `src`
 * (migrations excluded) and checks each seat insert it can recognise:
 *
 * - `create(ConversationParticipant, { ... })`: the literal names `identityId`;
 * - `<participants repository>.create({ ... })`: the literal names `identityId`;
 * - a raw `INSERT INTO "conversation_participants"`: the statement names
 *   `"identity_id"`.
 *
 * A seat written some other way is outside what this can see, so the scan
 * also asserts it found the sites known today, which keeps a scan that stops
 * matching from passing with nothing checked.
 */

const SOURCE_ROOT = join(__dirname, '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'migrations' ? [] : sourceFiles(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
      ? [path]
      : [];
  });
}

/** The balanced `{ ... }` starting at `openBraceIndex`. */
function objectLiteralAt(source: string, openBraceIndex: number): string {
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex, index + 1);
    }
  }
  return source.slice(openBraceIndex);
}

/** The template literal the raw INSERT sits in, up to its closing backtick. */
function statementAt(source: string, insertIndex: number): string {
  const closingBacktickIndex = source.indexOf('`', insertIndex);
  return source.slice(
    insertIndex,
    closingBacktickIndex === -1 ? undefined : closingBacktickIndex,
  );
}

interface SeatInsertSite {
  location: string;
  hasIdentity: boolean;
}

function seatInsertSites(): SeatInsertSite[] {
  const sites: SeatInsertSite[] = [];
  const literalPatterns = [
    /create\(\s*ConversationParticipant\s*,\s*\{/g,
    /\b(?:participants|participantsRepository|conversationParticipants)\.create\(\s*\{/g,
  ];
  for (const path of sourceFiles(SOURCE_ROOT)) {
    const source = readFileSync(path, 'utf8');
    const lineOf = (index: number) => source.slice(0, index).split('\n').length;
    const location = (index: number) =>
      `${relative(SOURCE_ROOT, path)}:${lineOf(index)}`;
    for (const pattern of literalPatterns) {
      for (const match of source.matchAll(pattern)) {
        const openBraceIndex = match.index + match[0].length - 1;
        sites.push({
          location: location(match.index),
          hasIdentity: /\bidentityId\b/.test(
            objectLiteralAt(source, openBraceIndex),
          ),
        });
      }
    }
    for (const match of source.matchAll(
      /INSERT INTO "?conversation_participants"?/gi,
    )) {
      sites.push({
        location: location(match.index),
        hasIdentity: statementAt(source, match.index).includes('"identity_id"'),
      });
    }
  }
  return sites;
}

describe('conversation_participants seat inserts carry an identity (F2 tripwire)', () => {
  const sites = seatInsertSites();

  it('finds the seat inserts known today, so a scan that stops matching cannot pass empty', () => {
    const locations = sites.map((site) => site.location.replace(/:\d+$/, ''));
    expect(locations).toEqual(
      expect.arrayContaining([
        'messaging/groups.service.ts',
        'messaging/group-invites.service.ts',
        'messaging/messaging-core.service.ts',
        'official-messages/official-conversations.service.ts',
        'identities/identity-mailbox-sync.service.ts',
      ]),
    );
    expect(sites.length).toBeGreaterThanOrEqual(10);
  });

  it('every seat insert names identityId or "identity_id"', () => {
    const missing = sites
      .filter((site) => !site.hasIdentity)
      .map((site) => site.location);
    expect(missing).toEqual([]);
  });
});
