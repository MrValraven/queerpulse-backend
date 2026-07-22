import {
  initialsFor,
  toneFor,
  moderationStateFor,
  toAdminMemberCard,
  toFlaggedMember,
  toAdminMemberDetail,
  type VouchAvatarDTO,
} from './admin-members-response';

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
      openReportCount: 0,
      communities: ['circle-of-care'],
      vouchCount: 2,
      vouchedBy: [],
    });

    expect(card.name).toBe('Inês Martins');
    expect(card.initials).toBe(initialsFor('Inês', 'Martins'));
    expect(card.tone).toBe(toneFor('ines-martins'));
    expect(card.joinedAt).toBe('2025-01-01T00:00:00.000Z');
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
      openReportCount: 1,
      vouchCount: 4,
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
      graph: { center: vouchAvatar, nodes: [vouchAvatar] },
    });

    expect(detail.contributions[0]!.at).toBe('2025-03-05T00:00:00.000Z');
    expect(detail.moderationTimeline[0]!.at).toBe('2025-03-06T00:00:00.000Z');
    expect(detail.name).toBe('Devon Rae');
  });
});
