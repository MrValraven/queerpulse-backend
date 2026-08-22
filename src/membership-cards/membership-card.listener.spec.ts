import { MembershipCardListener } from './membership-card.listener';

function makeListener() {
  const programs = {
    programForCommunity: jest
      .fn()
      .mockResolvedValue({ id: 'prog-1', isEnabled: true }),
  };
  const cards = {
    issue: jest.fn().mockResolvedValue({ id: 'card-1' }),
    revokeForUser: jest.fn().mockResolvedValue(undefined),
  };
  return {
    listener: new MembershipCardListener(programs as never, cards as never),
    programs,
    cards,
  };
}

describe('MembershipCardListener', () => {
  it('issues a card when a member joins a community that runs a programme', async () => {
    const { listener, cards } = makeListener();
    await listener.handleJoined({ communityId: 'com-1', userId: 'user-1' });
    expect(cards.issue).toHaveBeenCalledWith('prog-1', 'user-1');
  });

  it('issues nothing when the community runs no programme', async () => {
    const { listener, cards, programs } = makeListener();
    programs.programForCommunity.mockResolvedValue(null);
    await listener.handleJoined({ communityId: 'com-1', userId: 'user-1' });
    expect(cards.issue).not.toHaveBeenCalled();
  });

  it('issues nothing while the programme is disabled', async () => {
    const { listener, cards, programs } = makeListener();
    programs.programForCommunity.mockResolvedValue({
      id: 'prog-1',
      isEnabled: false,
    });
    await listener.handleJoined({ communityId: 'com-1', userId: 'user-1' });
    expect(cards.issue).not.toHaveBeenCalled();
  });

  it('revokes the card when a member leaves', async () => {
    const { listener, cards } = makeListener();
    await listener.handleLeft({ communityId: 'com-1', userId: 'user-1' });
    expect(cards.revokeForUser).toHaveBeenCalledWith('com-1', 'user-1');
  });

  it('swallows an issuance failure so the join itself still succeeds', async () => {
    const { listener, cards } = makeListener();
    cards.issue.mockRejectedValue(new Error('serial exhausted'));
    await expect(
      listener.handleJoined({ communityId: 'com-1', userId: 'user-1' }),
    ).resolves.toBeUndefined();
  });
});
