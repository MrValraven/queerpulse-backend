import { MyCardsService } from '../membership-cards/my-cards.service';
import { MembershipCardsExportContributor } from './data-export-contributors';

describe('MembershipCardsExportContributor', () => {
  it('registers under the membershipCards category/archive key', () => {
    const myCards = { forUser: jest.fn() } as unknown as MyCardsService;
    const contributor = new MembershipCardsExportContributor(myCards);
    expect(contributor.category).toBe('membershipCards');
    expect(contributor.archiveKey).toBe('membershipCards');
  });

  it("includes the caller's membership cards, delegating to MyCardsService.forUser", async () => {
    const cards = [
      {
        id: 'card-1',
        serial: 'AQ-7K4M2',
        status: 'active',
        issuedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: null,
        communityName: 'Azores Queer',
        communitySlug: 'azores-queer',
        role: 'member',
        holderName: 'Anika Kovač',
        program: {
          isEnabled: true,
          skin: 'plum',
          accentToken: 'accent',
          crestUrl: null,
          cardName: 'Sócie',
          validityMonths: null,
          allowsPrint: false,
          allowsWallet: false,
          allowsPublicBadge: true,
          serialPrefix: 'AQ',
        },
      },
    ];
    const forUser = jest.fn().mockResolvedValue(cards);
    const myCards = { forUser } as unknown as MyCardsService;
    const contributor = new MembershipCardsExportContributor(myCards);

    const result = await contributor.buildContribution('user-1');

    expect(forUser).toHaveBeenCalledWith('user-1');
    expect(result).toEqual([
      expect.objectContaining({
        serial: 'AQ-7K4M2',
        communitySlug: 'azores-queer',
      }),
    ]);
  });

  it('returns an empty archive for a member holding no cards', async () => {
    const myCards = {
      forUser: jest.fn().mockResolvedValue([]),
    } as unknown as MyCardsService;
    const contributor = new MembershipCardsExportContributor(myCards);

    await expect(contributor.buildContribution('user-2')).resolves.toEqual([]);
  });
});
