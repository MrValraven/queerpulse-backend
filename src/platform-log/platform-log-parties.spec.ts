import type { MemberRef } from '../common/member-ref';
import {
  toPlatformLogEntryDto,
  userIdsToResolve,
} from './platform-log-parties';
import type { PlatformLogRawEntry } from './platform-log.types';

function memberRef(firstName: string, lastName: string): MemberRef {
  return {
    slug: firstName.toLowerCase(),
    firstName,
    lastName,
    pronouns: null,
    avatarUrl: null,
  };
}

function rawEntry(
  overrides: Partial<PlatformLogRawEntry> = {},
): PlatformLogRawEntry {
  return {
    sourceKey: 'mod',
    rowId: 'row-1',
    occurredAtExact: '2026-10-05T12:00:00.123456Z',
    category: 'moderation',
    kind: 'mod.ban',
    actorUserId: 'staff-1',
    actorFallbackName: null,
    actorKind: 'staff',
    targetUserId: 'member-1',
    targetFallbackName: 'Bea Lopes',
    subject: null,
    params: {},
    note: 'Repeated slurs.',
    ...overrides,
  };
}

const NAMES = new Map<string, MemberRef>([
  ['staff-1', memberRef('Júlia', 'Saraiva')],
  ['member-1', memberRef('Bea', 'Lopes')],
]);

describe('platform log parties', () => {
  it('resolves names and keeps the staff note', () => {
    const dto = toPlatformLogEntryDto(rawEntry(), NAMES);
    expect(dto.id).toBe('mod:row-1');
    expect(dto.occurredAt).toBe('2026-10-05T12:00:00.123Z');
    expect(dto.actor).toEqual({
      userId: 'staff-1',
      name: 'Júlia Saraiva',
      kind: 'staff',
    });
    expect(dto.target).toEqual({
      userId: 'member-1',
      name: 'Bea Lopes',
      kind: 'member',
    });
    expect(dto.note).toBe('Repeated slurs.');
  });

  it('uses the snapshot when the target no longer resolves', () => {
    const dto = toPlatformLogEntryDto(rawEntry({ targetUserId: null }), NAMES);
    expect(dto.target).toEqual({
      userId: null,
      name: 'Bea Lopes',
      kind: 'member',
    });
  });

  it('reads an unresolvable actor with no fallback as erased', () => {
    const dto = toPlatformLogEntryDto(rawEntry({ actorUserId: 'gone' }), NAMES);
    expect(dto.actor).toEqual({ userId: null, name: '', kind: 'erased' });
  });

  it('never exposes an anonymous actor id and never sends a member note', () => {
    const dto = toPlatformLogEntryDto(
      rawEntry({
        actorKind: 'anonymous',
        actorUserId: 'member-1',
        note: 'secret',
      }),
      NAMES,
    );
    expect(dto.actor).toEqual({ userId: null, name: '', kind: 'anonymous' });
    expect(dto.note).toBeNull();
  });

  it('shows a system actor with its label when the table has one', () => {
    const dto = toPlatformLogEntryDto(
      rawEntry({
        actorKind: 'system',
        actorUserId: null,
        actorFallbackName: 'Roadmap import',
      }),
      NAMES,
    );
    expect(dto.actor).toEqual({
      userId: null,
      name: 'Roadmap import',
      kind: 'system',
    });
  });

  it('drops the target when the row has none', () => {
    const dto = toPlatformLogEntryDto(
      rawEntry({ targetUserId: null, targetFallbackName: null }),
      NAMES,
    );
    expect(dto.target).toBeNull();
  });

  it('collects ids to resolve, skipping anonymous actors', () => {
    expect(
      userIdsToResolve([
        rawEntry(),
        rawEntry({
          actorKind: 'anonymous',
          actorUserId: 'hidden',
          targetUserId: null,
        }),
      ]),
    ).toEqual(['staff-1', 'member-1']);
  });
});
