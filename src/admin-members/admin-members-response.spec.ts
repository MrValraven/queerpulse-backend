import { UserRole } from '../users/entities/user.entity';
import {
  initialsFor,
  toneFor,
  moderationStateFor,
  toAdminMemberCard,
  toFlaggedMember,
  toAdminMemberDetail,
  type VouchAvatarDTO,
} from './admin-members-response';
import { maskEmailAddress } from './admin-identity-response';

describe('initialsFor', () => {
  it('takes the first letter of first and last name, uppercased', () => {
    expect(initialsFor('Inês', 'Martins')).toBe('IM');
  });

  it('falls back to the first name initial when no last name', () => {
    expect(initialsFor('Kai', '')).toBe('K');
  });
});

describe('toneFor', () => {
  it('is deterministic for the same seed', () => {
    expect(toneFor('ines')).toBe(toneFor('ines'));
  });

  it('returns one of the five badge tones', () => {
    expect(['plum', 'coral', 'jade', 'violet', 'amber']).toContain(
      toneFor('devon'),
    );
  });
});

describe('moderationStateFor', () => {
  it('is frozen when the account is auto-frozen', () => {
    expect(
      moderationStateFor({ suspended: true, frozen: true, openReportCount: 1 }),
    ).toBe('frozen');
  });

  it('is limited when suspended but not frozen', () => {
    expect(
      moderationStateFor({
        suspended: true,
        frozen: false,
        openReportCount: 0,
      }),
    ).toBe('limited');
  });

  it('is under_review when only open reports exist', () => {
    expect(
      moderationStateFor({
        suspended: false,
        frozen: false,
        openReportCount: 3,
      }),
    ).toBe('under_review');
  });
});

describe('toAdminMemberCard', () => {
  it('composes name, initials, tone, and joinedAt from the resolved profile', () => {
    const card = toAdminMemberCard({
      profile: {
        userId: 'user-1',
        slug: 'ines-martins',
        firstName: 'Inês',
        lastName: 'Martins',
        pronouns: 'she/her',
        tagline: 'Softly, together.',
        avatarUrl: null,
        verified: true,
        joinedAt: new Date('2025-01-01T00:00:00.000Z'),
      },
      role: UserRole.Member,
      openReportCount: 0,
      communities: ['circle-of-care'],
      vouchCount: 2,
      vouchedBy: [],
      staffRoles: [],
    });

    expect(card.name).toBe('Inês Martins');
    expect(card.initials).toBe(initialsFor('Inês', 'Martins'));
    expect(card.tone).toBe(toneFor('ines-martins'));
    expect(card.joinedAt).toBe('2025-01-01T00:00:00.000Z');
    expect(card.role).toBe(UserRole.Member);
  });
});

describe('toFlaggedMember', () => {
  it('derives handle from slug and moderationState from the moderation flags', () => {
    const flaggedMember = toFlaggedMember({
      profile: {
        userId: 'user-2',
        slug: 'kai-devon',
        firstName: 'Kai',
        lastName: 'Devon',
        avatarUrl: null,
        joinedAt: new Date('2025-02-01T00:00:00.000Z'),
      },
      openReportCount: 3,
      moderation: { suspended: false, frozen: false },
      topReasonCode: 'harassment',
      latestReportDetail: 'Repeated unwanted messages.',
    });

    expect(flaggedMember.handle).toBe('@kai-devon');
    expect(flaggedMember.moderationState).toBe('under_review');
    expect(flaggedMember.topReasonCode).toBe('harassment');
  });
});

describe('toAdminMemberDetail', () => {
  const detailInput = () => ({
    profile: {
      userId: 'user-3',
      slug: 'devon-rae',
      firstName: 'Devon',
      lastName: 'Rae',
      pronouns: 'they/them',
      avatarUrl: null,
      verified: false,
      joinedAt: new Date('2025-03-01T00:00:00.000Z'),
    },
    role: UserRole.Moderator,
    isSystem: false,
    openReportCount: 1,
    vouchCount: 4,
    outboundVouchCount: 2,
    communities: [] as { name: string; role: 'owner' | 'mod' | 'member' }[],
    contributions: [] as { kind: string; detail: string | null; at: Date }[],
    moderationTimeline: [],
    graph: {
      center: {
        initials: 'DR',
        tone: 'plum' as const,
        slug: 'devon-rae',
        avatarUrl: null,
      },
      nodes: [],
    },
    staffRoles: [] as string[],
  });

  it('maps nested contributions and moderation timeline timestamps to ISO strings', () => {
    const vouchAvatar: VouchAvatarDTO = {
      initials: 'AB',
      tone: 'plum',
      slug: 'ally-b',
      avatarUrl: null,
    };

    const detail = toAdminMemberDetail({
      profile: {
        userId: 'user-3',
        slug: 'devon-rae',
        firstName: 'Devon',
        lastName: 'Rae',
        pronouns: 'they/them',
        avatarUrl: null,
        verified: false,
        joinedAt: new Date('2025-03-01T00:00:00.000Z'),
      },
      role: UserRole.Moderator,
      isSystem: false,
      openReportCount: 1,
      vouchCount: 4,
      outboundVouchCount: 2,
      communities: [{ name: 'Circle of Care', role: 'member' }],
      contributions: [
        {
          kind: 'post',
          detail: 'Welcome thread reply',
          at: new Date('2025-03-05T00:00:00.000Z'),
        },
      ],
      moderationTimeline: [
        {
          tone: 'neutral',
          action: 'warned',
          reasonCode: 'spam',
          actorName: 'Mod Alex',
          note: null,
          at: new Date('2025-03-06T00:00:00.000Z'),
          reportId: 'report-1',
        },
      ],
      graph: {
        center: vouchAvatar,
        nodes: [{ ...vouchAvatar, direction: 'inbound' }],
      },
      staffRoles: [],
      signInEmail: 'devon.rae@example.com',
    });

    expect(detail.contributions[0]!.at).toBe('2025-03-05T00:00:00.000Z');
    expect(detail.moderationTimeline[0]!.at).toBe('2025-03-06T00:00:00.000Z');
    expect(detail.name).toBe('Devon Rae');
  });

  // The mapper is the boundary the raw address must not cross: the console gets
  // the masked form on every drawer open, and the whole value only through the
  // recorded reveal endpoint.
  it('publishes the sign-in address masked, never in full', () => {
    const detail = toAdminMemberDetail({
      ...detailInput(),
      signInEmail: 'devon.rae@example.com',
    });

    expect(detail.signInEmailMasked).toBe('d\u2022\u2022\u2022e@example.com');
    expect(JSON.stringify(detail)).not.toContain('devon.rae@example.com');
  });

  // An erased user row leaves the profile behind, so the auth read comes back
  // empty. "We hold nothing here" has to stay distinguishable from a blank
  // field the console could mistake for a load failure.
  it('reports a missing auth row as null rather than an empty string', () => {
    const detail = toAdminMemberDetail({ ...detailInput(), signInEmail: null });

    expect(detail.signInEmailMasked).toBeNull();
  });
});

/**
 * The masking rules, stated as cases because each one is a decision about how
 * much of a real person's identity the console prints without being asked.
 */
describe('maskEmailAddress', () => {
  it('keeps the first and last character of the local part, and the whole domain', () => {
    expect(maskEmailAddress('devon.rae@gmail.com')).toBe(
      'd\u2022\u2022\u2022e@gmail.com',
    );
  });

  // The provider is the operator's first clue in a locked-out case (a workspace
  // address that stopped resolving), and it identifies nobody on its own.
  it('does not shorten a subdomained provider', () => {
    expect(maskEmailAddress('ines@mail.universidade.pt')).toBe(
      'i\u2022\u2022\u2022s@mail.universidade.pt',
    );
  });

  // Keeping either end of a one-character local part prints all of it.
  it('hides a single-character local part entirely', () => {
    expect(maskEmailAddress('a@example.com')).toBe(
      '\u2022\u2022\u2022@example.com',
    );
  });

  // Fixed-width elision: dots as numerous as the hidden characters would leak
  // the local part's length, which is a real signal on a short address. A
  // two-character local part and a thirty-character one print identically.
  it('elides to a fixed width whatever the length of the local part', () => {
    expect(maskEmailAddress('ab@x.com')).toBe('a\u2022\u2022\u2022b@x.com');
    expect(maskEmailAddress('a-very-long-local-part-indeed-b@x.com')).toBe(
      'a\u2022\u2022\u2022b@x.com',
    );
  });

  // Not a validator. Guessing where the local part ended would be worse than
  // showing none of it.
  it('reveals nothing from a value that is not an address', () => {
    expect(maskEmailAddress('not-an-address')).toBe('\u2022\u2022\u2022');
    expect(maskEmailAddress('@example.com')).toBe('\u2022\u2022\u2022');
    expect(maskEmailAddress('')).toBe('\u2022\u2022\u2022');
  });
});
