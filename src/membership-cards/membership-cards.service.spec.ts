import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MembershipCardsService } from './membership-cards.service';
import {
  MembershipCard,
  MembershipCardStatus,
} from './entities/membership-card.entity';
import { CardSkin } from './entities/community-card.entity';

function makeService() {
  const cards = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((row: Partial<MembershipCard>) => row),
    save: jest.fn((row: Partial<MembershipCard>) =>
      Promise.resolve({ id: 'card-1', ...row }),
    ),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const members = { find: jest.fn().mockResolvedValue([]) };
  const programRow = {
    id: 'prog-1',
    issuerId: 'com-1',
    isEnabled: true,
    validityMonths: 12,
    serialPrefix: 'AQ',
    skin: CardSkin.Plum,
  };
  const programRepo = { findOne: jest.fn().mockResolvedValue(programRow) };
  const communityRow = {
    id: 'com-1',
    name: 'Azores Queer',
    frozenAt: null,
    archivedAt: null,
  };
  const communities = { findOne: jest.fn().mockResolvedValue(communityRow) };
  const programs = {
    programForCommunity: jest.fn().mockResolvedValue(programRow),
  };
  const serials = { generate: jest.fn().mockResolvedValue('AQ-7K4M2') };
  const membership = {
    assertOwnerOrModBySlug: jest.fn().mockResolvedValue('com-1'),
  };
  // The real API (`CommunityGovernanceLogService.log`, see
  // `src/communities/community-governance-log.service.ts`) takes
  // `{ communityId, actorUserId, action, targetUserId?, metadata? }` — there
  // is no `record` method and no `detail` field.
  const governance = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new MembershipCardsService(
    cards as never,
    programRepo as never,
    members as never,
    communities as never,
    programs as never,
    serials as never,
    membership as never,
    governance as never,
  );
  return {
    service,
    cards,
    members,
    programRepo,
    communities,
    programs,
    serials,
    membership,
    governance,
  };
}

describe('MembershipCardsService.issue', () => {
  it('stamps an expiry from the programme validity window', async () => {
    const { service, cards } = makeService();
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 1));
    await service.issue('prog-1', 'user-1');
    const saved = cards.save.mock.calls[0]![0] as MembershipCard;
    expect(saved.expiresAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    jest.restoreAllMocks();
  });

  it('leaves the expiry null when the programme never expires', async () => {
    const { service, cards, programRepo } = makeService();
    programRepo.findOne.mockResolvedValue({
      id: 'prog-1',
      issuerId: 'com-1',
      isEnabled: true,
      validityMonths: null,
      serialPrefix: 'AQ',
    });
    await service.issue('prog-1', 'user-1');
    const saved = cards.save.mock.calls[0]![0] as MembershipCard;
    expect(saved.expiresAt).toBeNull();
  });

  it('is idempotent: an existing card is returned rather than duplicated', async () => {
    const { service, cards } = makeService();
    cards.findOne.mockResolvedValue({
      id: 'card-existing',
      status: MembershipCardStatus.Active,
    });
    const card = await service.issue('prog-1', 'user-1');
    expect(card.id).toBe('card-existing');
    expect(cards.save).not.toHaveBeenCalled();
  });

  it('reactivates a previously revoked card instead of creating a second one', async () => {
    const { service, cards } = makeService();
    cards.findOne.mockResolvedValue({
      id: 'card-existing',
      status: MembershipCardStatus.Revoked,
      revokedAt: new Date(),
      revokedReason: 'left',
    });
    const card = await service.issue('prog-1', 'user-1');
    expect(card.status).toBe(MembershipCardStatus.Active);
    expect(card.revokedAt).toBeNull();
    expect(card.revokedReason).toBeNull();
  });

  it('re-stamps a fresh expiry on reactivation rather than keeping the stale one', async () => {
    const { service, cards } = makeService();
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 1));
    cards.findOne.mockResolvedValue({
      id: 'card-existing',
      status: MembershipCardStatus.Revoked,
      revokedAt: new Date('2025-01-01T00:00:00.000Z'),
      revokedReason: 'left',
      // Stale: expired long before "now", from the original issue.
      expiresAt: new Date('2025-06-01T00:00:00.000Z'),
    });
    const card = await service.issue('prog-1', 'user-1');
    expect(card.expiresAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    jest.restoreAllMocks();
  });

  it('re-stamps a null expiry on reactivation when the programme no longer expires', async () => {
    const { service, cards, programRepo } = makeService();
    programRepo.findOne.mockResolvedValue({
      id: 'prog-1',
      issuerId: 'com-1',
      isEnabled: true,
      validityMonths: null,
      serialPrefix: 'AQ',
    });
    cards.findOne.mockResolvedValue({
      id: 'card-existing',
      status: MembershipCardStatus.Revoked,
      revokedAt: new Date(),
      revokedReason: 'left',
      expiresAt: new Date('2025-06-01T00:00:00.000Z'),
    });
    const card = await service.issue('prog-1', 'user-1');
    expect(card.expiresAt).toBeNull();
  });

  it('retries with a freshly-generated serial when the insert races a unique-violation, then succeeds', async () => {
    const { service, cards, serials } = makeService();
    cards.save
      .mockRejectedValueOnce({
        code: '23505',
        constraint: 'UQ_membership_cards_serial',
      })
      .mockImplementationOnce((row: Partial<MembershipCard>) =>
        Promise.resolve({ id: 'card-2', ...row }),
      );
    serials.generate
      .mockResolvedValueOnce('AQ-7K4M2')
      .mockResolvedValueOnce('AQ-9P3XZ');

    const card = await service.issue('prog-1', 'user-1');

    expect(serials.generate).toHaveBeenCalledTimes(2);
    expect(cards.save).toHaveBeenCalledTimes(2);
    expect(card.id).toBe('card-2');
    expect(card.serial).toBe('AQ-9P3XZ');
  });

  it('rethrows after exhausting all retry attempts on a persistent serial race', async () => {
    const { service, cards } = makeService();
    cards.save.mockRejectedValue({
      code: '23505',
      constraint: 'UQ_membership_cards_serial',
    });

    await expect(service.issue('prog-1', 'user-1')).rejects.toMatchObject({
      code: '23505',
    });
    expect(cards.save).toHaveBeenCalledTimes(3);
  });

  it('does not retry a unique-violation on a different constraint', async () => {
    const { service, cards } = makeService();
    cards.save.mockRejectedValue({
      code: '23505',
      constraint: 'UQ_membership_cards_program_user',
    });

    await expect(service.issue('prog-1', 'user-1')).rejects.toMatchObject({
      constraint: 'UQ_membership_cards_program_user',
    });
    expect(cards.save).toHaveBeenCalledTimes(1);
  });
});

describe('MembershipCardsService.setStatus', () => {
  it('requires a reason to revoke', async () => {
    const { service, cards } = makeService();
    cards.findOne.mockResolvedValue({
      id: 'card-1',
      programId: 'prog-1',
      status: MembershipCardStatus.Active,
    });
    await expect(
      service.setStatus('azores-queer', 'mod-1', 'card-1', 'revoked'),
    ).rejects.toThrow(BadRequestException);
  });

  it('stores the reason and stamps revokedAt', async () => {
    const { service, cards } = makeService();
    cards.findOne.mockResolvedValue({
      id: 'card-1',
      programId: 'prog-1',
      status: MembershipCardStatus.Active,
    });
    const card = await service.setStatus(
      'azores-queer',
      'mod-1',
      'card-1',
      'revoked',
      'Left under a safety report',
    );
    expect(card.status).toBe(MembershipCardStatus.Revoked);
    expect(card.revokedReason).toBe('Left under a safety report');
    expect(card.revokedAt).toBeInstanceOf(Date);
  });

  it('clears the revocation trail on reinstatement', async () => {
    const { service, cards } = makeService();
    cards.findOne.mockResolvedValue({
      id: 'card-1',
      programId: 'prog-1',
      status: MembershipCardStatus.Revoked,
      revokedAt: new Date(),
      revokedReason: 'left',
    });
    const card = await service.setStatus(
      'azores-queer',
      'mod-1',
      'card-1',
      'active',
    );
    expect(card.revokedAt).toBeNull();
    expect(card.revokedReason).toBeNull();
  });

  it('404s a card that belongs to another community', async () => {
    const { service, cards } = makeService();
    cards.findOne.mockResolvedValue(null);
    await expect(
      service.setStatus('azores-queer', 'mod-1', 'card-x', 'suspended', 'why'),
    ).rejects.toThrow(NotFoundException);
  });

  it('records a governance entry naming the action', async () => {
    const { service, cards, governance } = makeService();
    cards.findOne.mockResolvedValue({
      id: 'card-1',
      programId: 'prog-1',
      status: MembershipCardStatus.Active,
    });
    await service.setStatus(
      'azores-queer',
      'mod-1',
      'card-1',
      'revoked',
      'why',
    );
    expect(governance.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'card_revoked', actorUserId: 'mod-1' }),
    );
  });
});

describe('MembershipCardsService.revokeForUser', () => {
  it('revokes the card when someone leaves the roster', async () => {
    const { service, cards } = makeService();
    cards.findOne.mockResolvedValue({
      id: 'card-1',
      status: MembershipCardStatus.Active,
    });
    await service.revokeForUser('com-1', 'user-1');
    const saved = cards.save.mock.calls[0]![0] as MembershipCard;
    expect(saved.status).toBe(MembershipCardStatus.Revoked);
    expect(saved.revokedReason).toBe('Left the community');
  });

  it('does nothing when the community runs no card programme', async () => {
    const { service, cards, programs } = makeService();
    programs.programForCommunity.mockResolvedValue(null);
    await service.revokeForUser('com-1', 'user-1');
    expect(cards.save).not.toHaveBeenCalled();
  });
});

describe('MembershipCardsService.resolveEffectiveStatus', () => {
  it('resolves an active card as active', async () => {
    const { service } = makeService();
    const status = await service.resolveEffectiveStatus({
      programId: 'prog-1',
      status: MembershipCardStatus.Active,
      expiresAt: null,
    } as MembershipCard);
    expect(status).toBe('active');
  });

  it('resolves a revoked card as revoked', async () => {
    const { service } = makeService();
    const status = await service.resolveEffectiveStatus({
      programId: 'prog-1',
      status: MembershipCardStatus.Revoked,
      expiresAt: null,
    } as MembershipCard);
    expect(status).toBe('revoked');
  });

  it('resolves a card past its expiry date as expired', async () => {
    const { service } = makeService();
    const status = await service.resolveEffectiveStatus({
      programId: 'prog-1',
      status: MembershipCardStatus.Active,
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    } as MembershipCard);
    expect(status).toBe('expired');
  });

  it('returns null when the card programme can no longer be resolved', async () => {
    const { service, programRepo } = makeService();
    programRepo.findOne.mockResolvedValue(null);
    const status = await service.resolveEffectiveStatus({
      programId: 'gone',
      status: MembershipCardStatus.Active,
      expiresAt: null,
    } as MembershipCard);
    expect(status).toBeNull();
  });

  it('returns null when the issuing community can no longer be resolved', async () => {
    const { service, communities } = makeService();
    communities.findOne.mockResolvedValue(null);
    const status = await service.resolveEffectiveStatus({
      programId: 'prog-1',
      status: MembershipCardStatus.Active,
      expiresAt: null,
    } as MembershipCard);
    expect(status).toBeNull();
  });
});

describe('MembershipCardsService.deleteOwnCard', () => {
  it('deletes a card the caller holds', async () => {
    const { service, cards } = makeService();
    cards.findOne.mockResolvedValue({ id: 'card-1', userId: 'user-1' });
    await service.deleteOwnCard('card-1', 'user-1');
    expect(cards.delete).toHaveBeenCalledWith('card-1');
  });

  it('404s a card that belongs to someone else, without deleting it', async () => {
    const { service, cards } = makeService();
    cards.findOne.mockResolvedValue({ id: 'card-1', userId: 'someone-else' });
    await expect(
      service.deleteOwnCard('card-1', 'user-1'),
    ).rejects.toThrow(NotFoundException);
    expect(cards.delete).not.toHaveBeenCalled();
  });

  it('404s a card id that does not exist', async () => {
    const { service, cards } = makeService();
    cards.findOne.mockResolvedValue(null);
    await expect(
      service.deleteOwnCard('missing', 'user-1'),
    ).rejects.toThrow(NotFoundException);
    expect(cards.delete).not.toHaveBeenCalled();
  });
});
