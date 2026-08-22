import { CardVerificationService } from './card-verification.service';
import { MembershipCardStatus } from './entities/membership-card.entity';

function makeService() {
  const tokens = {
    verify: jest.fn().mockReturnValue({ cardId: 'card-1', codeVersion: 1 }),
  };
  const cards = {
    cardById: jest.fn().mockResolvedValue({
      id: 'card-1',
      programId: 'prog-1',
      userId: 'user-1',
      serial: 'AQ-7K4M2',
      status: MembershipCardStatus.Active,
      issuedAt: new Date('2026-02-01T00:00:00Z'),
      expiresAt: null,
      revokedReason: 'Left under a safety report',
      codeVersion: 1,
      isPhotoHidden: false,
    }),
  };
  const programs = {
    findOne: jest.fn().mockResolvedValue({
      id: 'prog-1',
      issuerId: 'com-1',
      isEnabled: true,
      allowsMemberPhoto: false,
    }),
  };
  const communities = {
    findOne: jest.fn().mockResolvedValue({
      id: 'com-1',
      name: 'Azores Queer',
      frozenAt: null,
      archivedAt: null,
    }),
  };
  const members = {
    findOne: jest.fn().mockResolvedValue({ role: 'member' }),
  };
  const users = {
    findOne: jest.fn().mockResolvedValue({
      firstName: 'Rita',
      lastName: 'V',
      avatarUrl: 'media/rita.jpg',
    }),
  };
  const service = new CardVerificationService(
    tokens as never,
    cards as never,
    programs as never,
    communities as never,
    members as never,
    users as never,
  );
  return { service, tokens, cards, programs, communities, members, users };
}

describe('CardVerificationService.verify', () => {
  it('returns the thin payload for a valid card', async () => {
    const { service } = makeService();
    const result = await service.verify('good.token');
    expect(result).toEqual({
      status: 'active',
      issuerName: 'Azores Queer',
      holderName: 'Rita V',
      role: 'member',
      serial: 'AQ-7K4M2',
      memberSince: '2026-02-01T00:00:00.000Z',
      hasPhoto: false,
    });
  });

  it('returns null for a token that does not verify', async () => {
    const { service, tokens } = makeService();
    tokens.verify.mockReturnValue(null);
    expect(await service.verify('bad.token')).toBeNull();
  });

  it('returns null when the token verifies but the card is gone', async () => {
    const { service, cards } = makeService();
    cards.cardById.mockResolvedValue(null);
    expect(await service.verify('good.token')).toBeNull();
  });

  // Spec §L.2
  it('reports suspended while the issuing community is frozen', async () => {
    const { service, communities } = makeService();
    communities.findOne.mockResolvedValue({
      id: 'com-1',
      name: 'Azores Queer',
      frozenAt: new Date('2026-08-20T00:00:00Z'),
      archivedAt: null,
    });
    expect((await service.verify('good.token'))?.status).toBe('suspended');
  });

  it('reports revoked when the issuing community is archived', async () => {
    const { service, communities } = makeService();
    communities.findOne.mockResolvedValue({
      id: 'com-1',
      name: 'Azores Queer',
      frozenAt: null,
      archivedAt: new Date('2026-08-20T00:00:00Z'),
    });
    expect((await service.verify('good.token'))?.status).toBe('revoked');
  });

  it('never discloses the revocation reason', async () => {
    const { service, cards } = makeService();
    cards.cardById.mockResolvedValue({
      id: 'card-1',
      programId: 'prog-1',
      userId: 'user-1',
      serial: 'AQ-7K4M2',
      status: MembershipCardStatus.Revoked,
      issuedAt: new Date('2026-02-01T00:00:00Z'),
      expiresAt: null,
      revokedReason: 'Left under a safety report',
      codeVersion: 1,
      isPhotoHidden: false,
    });
    const result = await service.verify('good.token');
    expect(JSON.stringify(result)).not.toContain('safety report');
    expect(result?.status).toBe('revoked');
  });

  it('falls back to a placeholder name when the holder is erased', async () => {
    const { service, users } = makeService();
    users.findOne.mockResolvedValue(null);
    expect((await service.verify('good.token'))?.holderName).toBe('A member');
  });

  // The generation check behind "replace a lost card". The row is untouched;
  // only the code the paper carries has moved on.
  it('returns null when the scanned code is a superseded generation', async () => {
    const { service, cards } = makeService();
    cards.cardById.mockResolvedValue({
      id: 'card-1',
      programId: 'prog-1',
      userId: 'user-1',
      serial: 'AQ-7K4M2',
      status: MembershipCardStatus.Active,
      issuedAt: new Date('2026-02-01T00:00:00Z'),
      expiresAt: null,
      revokedReason: null,
      codeVersion: 2,
      isPhotoHidden: false,
    });
    expect(await service.verify('printed.token')).toBeNull();
  });

  it('reports hasPhoto true when the programme prints photos and the holder has one', async () => {
    const { service, programs } = makeService();
    programs.findOne.mockResolvedValue({
      id: 'prog-1',
      issuerId: 'com-1',
      isEnabled: true,
      allowsMemberPhoto: true,
    });
    expect((await service.verify('good.token'))?.hasPhoto).toBe(true);
  });

  it('reports hasPhoto false when the holder vetoed their own photo', async () => {
    const { service, programs, cards } = makeService();
    programs.findOne.mockResolvedValue({
      id: 'prog-1',
      issuerId: 'com-1',
      isEnabled: true,
      allowsMemberPhoto: true,
    });
    cards.cardById.mockResolvedValue({
      id: 'card-1',
      programId: 'prog-1',
      userId: 'user-1',
      serial: 'AQ-7K4M2',
      status: MembershipCardStatus.Active,
      issuedAt: new Date('2026-02-01T00:00:00Z'),
      expiresAt: null,
      revokedReason: null,
      codeVersion: 1,
      isPhotoHidden: true,
    });
    expect((await service.verify('good.token'))?.hasPhoto).toBe(false);
  });

  it('reports hasPhoto false when the holder has no avatar at all', async () => {
    const { service, programs, users } = makeService();
    programs.findOne.mockResolvedValue({
      id: 'prog-1',
      issuerId: 'com-1',
      isEnabled: true,
      allowsMemberPhoto: true,
    });
    users.findOne.mockResolvedValue({
      firstName: 'Rita',
      lastName: 'V',
      avatarUrl: null,
    });
    expect((await service.verify('good.token'))?.hasPhoto).toBe(false);
  });
});
