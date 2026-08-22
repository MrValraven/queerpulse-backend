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
    role: 'mod',
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
});

describe('toCardVerification', () => {
  it('returns only the thin verification payload', () => {
    const dto = toCardVerification(card(), 'active', {
      issuerName: 'Azores Queer',
      holderName: 'Rita V',
      role: 'member',
    });
    expect(Object.keys(dto).sort()).toEqual(
      [
        'holderName',
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
      { issuerName: 'Azores Queer', holderName: 'Rita V', role: 'member' },
    );
    expect(JSON.stringify(dto)).not.toContain('safety report');
    expect(dto.status).toBe('revoked');
  });
});
