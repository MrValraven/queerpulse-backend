import { DataSource } from 'typeorm';
import { NEW_DOMAIN_EXPORT_CONTRIBUTORS } from './data-export-contributors';
import { CommunityOwnershipOffersExportContributor } from './data-export-contributors-community-ownership';

const USER_ID = '73000000-0000-4000-8000-000000000514';
const OWNER_ID = '73000000-0000-4000-8000-000000000515';

interface DataSourceStandIn {
  query: jest.Mock;
}

// PRD-514. The ownership offers a member received or made belong to their own
// record, so the export carries them, with the other party named by id only.
describe('community ownership offers export contributor', () => {
  let dataSource: DataSourceStandIn;
  let contributor: CommunityOwnershipOffersExportContributor;

  beforeEach(() => {
    dataSource = { query: jest.fn().mockResolvedValue([]) };
    contributor = new CommunityOwnershipOffersExportContributor(
      dataSource as unknown as DataSource,
    );
  });

  it('rides on communities under its own key and is registered', () => {
    expect(contributor.category).toBe('communities');
    expect(contributor.archiveKey).toBe('communityOwnershipOffers');
    expect(NEW_DOMAIN_EXPORT_CONTRIBUTORS).toContain(
      CommunityOwnershipOffersExportContributor,
    );
  });

  it('reads both the offers addressed to the member and the ones they made', async () => {
    await contributor.buildContribution(USER_ID);

    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining(
        '"o"."offeree_id" = $1 OR "o"."offered_by_user_id" = $1',
      ),
      [USER_ID],
    );
  });

  it('writes one row per offer with the other party as an id', async () => {
    dataSource.query.mockResolvedValue([
      {
        id: 'offer-1',
        community_id: 'c1',
        community_slug: 'night-swim',
        community_name: 'Night swim',
        side: 'received',
        other_party_user_id: OWNER_ID,
        status: 'declined',
        offered_at: new Date('2026-11-01T00:00:00.000Z'),
        expires_at: new Date('2026-11-15T00:00:00.000Z'),
        responded_at: new Date('2026-11-02T00:00:00.000Z'),
      },
    ]);

    expect(await contributor.buildContribution(USER_ID)).toEqual([
      {
        id: 'offer-1',
        communityId: 'c1',
        communitySlug: 'night-swim',
        communityName: 'Night swim',
        side: 'received',
        otherPartyUserId: OWNER_ID,
        status: 'declined',
        offeredAt: '2026-11-01T00:00:00.000Z',
        expiresAt: '2026-11-15T00:00:00.000Z',
        respondedAt: '2026-11-02T00:00:00.000Z',
      },
    ]);
  });
});
