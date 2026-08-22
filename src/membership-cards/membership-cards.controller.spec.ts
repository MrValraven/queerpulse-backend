import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
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
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MembershipCardsController],
      providers: [
        { provide: MyCardsService, useValue: myCards },
        { provide: MembershipCardsService, useValue: cards },
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
