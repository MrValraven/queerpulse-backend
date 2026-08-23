import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import {
  toCardProgram,
  toCardVerification,
  toIssuerCard,
  toMyCard,
} from './membership-card-response';
import {
  CardIssuerType,
  CardSkin,
  CommunityCard,
} from './entities/community-card.entity';
import {
  MembershipCard,
  MembershipCardStatus,
} from './entities/membership-card.entity';

// A well-formed storage key (matches an existing upload-kind prefix + UUID
// pattern from `storage-key.ts`) so the real `toImageUrl` resolves it instead
// of rejecting it as malformed.
const CREST_KEY =
  'community-covers/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.png';

function program(overrides: Partial<CommunityCard> = {}): CommunityCard {
  return {
    id: 'prog-1',
    issuerType: CardIssuerType.Community,
    issuerId: 'com-1',
    isEnabled: true,
    skin: CardSkin.Plum,
    accentToken: 'accent',
    crestMediaKey: CREST_KEY,
    backgroundPreset: null,
    backgroundMediaKey: null,
    cardName: 'Sócie',
    validityMonths: 12,
    allowsPrint: false,
    allowsWallet: false,
    allowsPublicBadge: true,
    allowsMemberPhoto: false,
    photoStyle: 'color',
    allowsPronouns: false,
    textBackdrop: 'shade',
    serialPrefix: 'AZO',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function card(overrides: Partial<MembershipCard> = {}): MembershipCard {
  return {
    id: 'card-1',
    programId: 'prog-1',
    userId: 'user-1',
    serial: 'AZO-7K4M2',
    status: MembershipCardStatus.Active,
    issuedAt: new Date('2026-02-01T00:00:00Z'),
    expiresAt: null,
    revokedAt: null,
    revokedReason: 'Left under a safety report',
    isPubliclyVisible: false,
    isPhotoHidden: false,
    isPronounsHidden: false,
    codeVersion: 1,
    ...overrides,
  };
}

beforeEach(() => {
  setImageUrlBase('https://api.test');
});

afterEach(() => {
  resetImageUrlBaseForTesting();
});

describe('toCardProgram', () => {
  it('resolves the crest key to a fetchable URL', () => {
    const dto = toCardProgram(program());
    expect(dto.crestUrl).toBe(`https://api.test/files/${CREST_KEY}`);
  });

  it('leaves a missing crest null', () => {
    expect(toCardProgram(program({ crestMediaKey: null })).crestUrl).toBeNull();
  });

  it('never leaks the raw storage key', () => {
    expect(JSON.stringify(toCardProgram(program()))).not.toContain(
      'crestMediaKey',
    );
  });
});

describe('toMyCard', () => {
  it('carries the serial, holder role, and effective status', () => {
    const dto = toMyCard(card(), program(), 'active', {
      communityName: 'Azores Queer',
      communitySlug: 'azores-queer',
      role: 'member',
      holderName: 'Rita V',
      token: 'signed.code',
    });
    expect(dto.serial).toBe('AZO-7K4M2');
    expect(dto.status).toBe('active');
    expect(dto.communitySlug).toBe('azores-queer');
    expect(dto.role).toBe('member');
  });

  it('never exposes the revocation reason to the holder', () => {
    const dto = toMyCard(
      card({ status: MembershipCardStatus.Revoked }),
      program(),
      'revoked',
      {
        communityName: 'Azores Queer',
        communitySlug: 'azores-queer',
        role: 'member',
        holderName: 'Rita V',
        token: 'signed.code',
      },
    );
    expect(JSON.stringify(dto)).not.toContain('safety report');
  });
});

describe('toIssuerCard', () => {
  const holder = {
    holderSlug: 'rita',
    holderName: 'Rita V',
    avatarUrl: 'https://api.test/files/avatar.png',
    pronouns: 'she/her',
    role: 'mod',
    token: 'signed.code',
  };

  it('does expose the revocation reason, which is issuer-only', () => {
    const dto = toIssuerCard(card(), program(), 'active', holder);
    expect(dto.revokedReason).toBe('Left under a safety report');
  });

  it('carries the role the card prints', () => {
    expect(toIssuerCard(card(), program(), 'active', holder).role).toBe('mod');
  });

  it('withholds the card photo when the programme runs no photos', () => {
    const dto = toIssuerCard(
      card(),
      program({ allowsMemberPhoto: false }),
      'active',
      holder,
    );
    expect(dto.cardPhotoUrl).toBeNull();
    // The roster row still shows the profile picture, which is a different
    // question from what the card prints.
    expect(dto.avatarUrl).toBe(holder.avatarUrl);
  });

  it('withholds the card photo when the holder vetoed theirs', () => {
    const dto = toIssuerCard(
      card({ isPhotoHidden: true }),
      program({ allowsMemberPhoto: true }),
      'active',
      holder,
    );
    expect(dto.cardPhotoUrl).toBeNull();
  });

  it('sends the card photo when both switches allow it', () => {
    const dto = toIssuerCard(
      card({ isPhotoHidden: false }),
      program({ allowsMemberPhoto: true }),
      'active',
      holder,
    );
    expect(dto.cardPhotoUrl).toBe(holder.avatarUrl);
  });

  // The whole point of the permanent code: an issuer reading a member's card
  // sees the same value that member shows, so the roster can draw a real,
  // scannable symbol instead of a "holder only" sentence.
  it('carries the same permanent code the holder sees', () => {
    const dto = toIssuerCard(card(), program(), 'active', holder);
    expect(dto.token).toBe('signed.code');
  });
});

describe('toCardVerification', () => {
  it('returns only the thin verification payload', () => {
    const dto = toCardVerification(card(), 'active', {
      issuerName: 'Azores Queer',
      holderName: 'Rita V',
      role: 'member',
      hasPhoto: false,
      holderPronouns: null,
    });
    expect(Object.keys(dto).sort()).toEqual(
      [
        'hasPhoto',
        'holderName',
        'holderPronouns',
        'issuerName',
        'memberSince',
        'role',
        'serial',
        'status',
      ].sort(),
    );
  });

  it('never discloses why a card was revoked', () => {
    const dto = toCardVerification(
      card({ status: MembershipCardStatus.Revoked }),
      'revoked',
      {
        issuerName: 'Azores Queer',
        holderName: 'Rita V',
        role: 'member',
        hasPhoto: false,
        holderPronouns: null,
      },
    );
    expect(JSON.stringify(dto)).not.toContain('safety report');
    expect(dto.status).toBe('revoked');
  });
});

describe('the permanent code on a card DTO', () => {
  it('is carried on a card of any status', () => {
    const dto = toMyCard(
      card({ status: MembershipCardStatus.Revoked }),
      program(),
      'revoked',
      {
        communityName: 'Azores Queer',
        communitySlug: 'azores-queer',
        role: 'member',
        holderName: 'Rita V',
        token: 'signed.code',
      },
    );
    expect(dto.token).toBe('signed.code');
  });

  it('is null when the platform has no signing key', () => {
    const dto = toMyCard(card(), program(), 'active', {
      communityName: 'Azores Queer',
      communitySlug: 'azores-queer',
      role: 'member',
      holderName: 'Rita V',
      token: null,
    });
    expect(dto.token).toBeNull();
  });
});

describe('pronouns on a card', () => {
  const context = {
    communityName: 'Azores Queer',
    communitySlug: 'azores-queer',
    role: 'member',
    holderName: 'Rita V',
    holderPronouns: 'she/her',
    token: 'signed.code',
  };

  it('withholds them when the programme does not print pronouns', () => {
    const dto = toMyCard(
      card(),
      program({ allowsPronouns: false }),
      'active',
      context,
    );
    expect(dto.holderPronouns).toBeNull();
  });

  it('withholds them when the holder vetoed theirs', () => {
    const dto = toMyCard(
      card({ isPronounsHidden: true }),
      program({ allowsPronouns: true }),
      'active',
      context,
    );
    expect(dto.holderPronouns).toBeNull();
    // The veto still reports its own state, so the member's toggle can show
    // the truth rather than reading an absent value as "off".
    expect(dto.isPronounsHidden).toBe(true);
  });

  it('sends them when both switches allow it', () => {
    const dto = toMyCard(
      card(),
      program({ allowsPronouns: true }),
      'active',
      context,
    );
    expect(dto.holderPronouns).toBe('she/her');
  });

  it('reads blank profile pronouns as none at all', () => {
    const dto = toMyCard(card(), program({ allowsPronouns: true }), 'active', {
      ...context,
      holderPronouns: '   ',
    });
    expect(dto.holderPronouns).toBeNull();
  });

  it('applies the same pair of switches to the issuer view', () => {
    const holder = {
      holderSlug: 'rita',
      holderName: 'Rita V',
      avatarUrl: null,
      pronouns: 'she/her',
      role: 'mod',
      token: 'signed.code',
    };
    expect(
      toIssuerCard(card(), program({ allowsPronouns: true }), 'active', holder)
        .cardPronouns,
    ).toBe('she/her');
    expect(
      toIssuerCard(
        card({ isPronounsHidden: true }),
        program({ allowsPronouns: true }),
        'active',
        holder,
      ).cardPronouns,
    ).toBeNull();
  });
});
