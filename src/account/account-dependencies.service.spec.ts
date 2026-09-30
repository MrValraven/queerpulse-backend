import { RosterRole } from '../communities/entities/community-member.entity';
import { ListingStatus } from '../listings/entities/listing.entity';
import { AccountDependenciesService } from './account-dependencies.service';

const USER_ID = 'user-1';

/**
 * `GET /account/dependencies` backs the delete-account ownership warning for
 * EVERY signed-in member, banned and suspended ones included. These tests pin
 * the two selection rules the warning depends on: owned (roster role `owner`)
 * unarchived communities, and the caller's own live listings.
 */
describe('AccountDependenciesService', () => {
  const build = ({
    communityRows = [] as { slug: string; name: string }[],
    listingRows = [] as { ref: string; name: string }[],
  } = {}) => {
    const communityQuery = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(communityRows),
    };
    const communities = {
      createQueryBuilder: jest.fn().mockReturnValue(communityQuery),
    };
    const listings = { find: jest.fn().mockResolvedValue(listingRows) };
    const service = new AccountDependenciesService(
      communities as never,
      listings as never,
    );
    return { service, communityQuery, listings };
  };

  it('returns owned communities and live owned listings together', async () => {
    const { service } = build({
      communityRows: [{ slug: 'quiet-readers', name: 'Quiet Readers' }],
      listingRows: [{ ref: 'L-1', name: 'Corner Cafe' }],
    });

    await expect(service.forUser(USER_ID)).resolves.toEqual({
      communities: [{ slug: 'quiet-readers', name: 'Quiet Readers' }],
      listings: [{ ref: 'L-1', name: 'Corner Cafe' }],
    });
  });

  it('returns two empty lists for a member who owns nothing', async () => {
    const { service } = build();

    await expect(service.forUser(USER_ID)).resolves.toEqual({
      communities: [],
      listings: [],
    });
  });

  it('selects communities by the caller, the owner role and not archived', async () => {
    const { service, communityQuery } = build();

    await service.forUser(USER_ID);

    expect(communityQuery.where).toHaveBeenCalledWith('m.user_id = :userId', {
      userId: USER_ID,
    });
    expect(communityQuery.andWhere).toHaveBeenCalledWith(
      'm.role = :ownerRole',
      { ownerRole: RosterRole.Owner },
    );
    expect(communityQuery.andWhere).toHaveBeenCalledWith(
      'c.archived_at IS NULL',
    );
  });

  it('keeps private-tier communities in the warning (no privacy filter)', async () => {
    const { service, communityQuery } = build();

    await service.forUser(USER_ID);

    const filterClauses = [communityQuery.where, communityQuery.andWhere]
      .flatMap((filterMock) => filterMock.mock.calls as unknown[][])
      .map(([clause]) => String(clause));
    expect(filterClauses.some((clause) => /privacy|tier/i.test(clause))).toBe(
      false,
    );
  });

  it('selects listings the caller owns whose status is live', async () => {
    const { service, listings } = build();

    await service.forUser(USER_ID);

    expect(listings.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerId: USER_ID, status: ListingStatus.Live },
      }),
    );
  });

  it('answers with ref and name only for each listing', async () => {
    const { service } = build({
      listingRows: [
        {
          ref: 'L-2',
          name: 'Night Market',
          ownerId: USER_ID,
        } as { ref: string; name: string },
      ],
    });

    const result = await service.forUser(USER_ID);

    expect(result.listings).toEqual([{ ref: 'L-2', name: 'Night Market' }]);
  });
});
