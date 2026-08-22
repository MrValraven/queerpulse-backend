import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { CardTokenService } from './card-token.service';
import { MembershipCard } from './entities/membership-card.entity';
import { MembershipCardsController } from './membership-cards.controller';
import { MembershipCardsService } from './membership-cards.service';
import { MyCardsService } from './my-cards.service';

describe('MembershipCardsController', () => {
  let controller: MembershipCardsController;
  let myCards: { forUser: jest.Mock };
  let cards: {
    cardById: jest.Mock;
    resolveEffectiveStatus: jest.Mock;
    deleteOwnCard: jest.Mock;
  };
  let tokens: { mint: jest.Mock };

  const user: CurrentUserData = {
    userId: 'user-1',
    email: 'user-1@example.com',
    status: 'active',
    role: 'member',
  };

  const ownCard = { id: 'card-1', userId: 'user-1' } as MembershipCard;

  beforeEach(async () => {
    myCards = { forUser: jest.fn().mockResolvedValue([]) };
    cards = {
      cardById: jest.fn().mockResolvedValue(ownCard),
      resolveEffectiveStatus: jest.fn().mockResolvedValue('active'),
      deleteOwnCard: jest.fn().mockResolvedValue(undefined),
    };
    tokens = {
      mint: jest
        .fn()
        .mockResolvedValue({ token: 'signed', expiresAt: 'later' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MembershipCardsController],
      providers: [
        { provide: MyCardsService, useValue: myCards },
        { provide: MembershipCardsService, useValue: cards },
        { provide: CardTokenService, useValue: tokens },
      ],
    }).compile();

    controller = module.get(MembershipCardsController);
  });

  describe('list', () => {
    it('delegates to MyCardsService with the caller id', async () => {
      await controller.list(user);
      expect(myCards.forUser).toHaveBeenCalledWith('user-1');
    });
  });

  describe('token', () => {
    it('mints a token for an active card the caller holds', async () => {
      const result = await controller.token(user, 'card-1');
      expect(cards.resolveEffectiveStatus).toHaveBeenCalledWith(ownCard);
      expect(tokens.mint).toHaveBeenCalledWith('card-1');
      expect(result).toEqual({ token: 'signed', expiresAt: 'later' });
    });

    it('404s for a card the caller does not hold, without minting', async () => {
      cards.cardById.mockResolvedValue({
        id: 'card-1',
        userId: 'someone-else',
      });
      await expect(controller.token(user, 'card-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(tokens.mint).not.toHaveBeenCalled();
    });

    it('404s for a missing card id, without minting', async () => {
      cards.cardById.mockResolvedValue(null);
      await expect(controller.token(user, 'missing')).rejects.toThrow(
        NotFoundException,
      );
      expect(tokens.mint).not.toHaveBeenCalled();
    });

    it('404s a revoked card rather than minting a fresh token', async () => {
      cards.resolveEffectiveStatus.mockResolvedValue('revoked');
      await expect(controller.token(user, 'card-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(tokens.mint).not.toHaveBeenCalled();
    });

    it('404s a suspended card rather than minting a fresh token', async () => {
      cards.resolveEffectiveStatus.mockResolvedValue('suspended');
      await expect(controller.token(user, 'card-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(tokens.mint).not.toHaveBeenCalled();
    });

    it('404s an expired card rather than minting a fresh token', async () => {
      cards.resolveEffectiveStatus.mockResolvedValue('expired');
      await expect(controller.token(user, 'card-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(tokens.mint).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('delegates to MembershipCardsService.deleteOwnCard and confirms', async () => {
      const result = await controller.remove(user, 'card-1');
      expect(cards.deleteOwnCard).toHaveBeenCalledWith('card-1', 'user-1');
      expect(result).toEqual({ ok: true });
    });

    it('propagates the 404 for a card the caller does not hold', async () => {
      cards.deleteOwnCard.mockRejectedValue(
        new NotFoundException('Card not found'),
      );
      await expect(controller.remove(user, 'card-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
