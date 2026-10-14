import { Repository } from 'typeorm';
import { SavedItem, SavedKind } from './entities/saved-item.entity';
import { SavedAvailabilityService } from './saved-availability.service';
import { SavedListsService } from './saved-lists.service';
import { SavedService } from './saved.service';

const RELEASE_ID = 'c6000000-0000-4000-8000-000000000001';
const FIRST_MEMBER = 'c7000000-0000-4000-8000-000000000001';
const SECOND_MEMBER = 'c7000000-0000-4000-8000-000000000002';

describe('SavedService.saveForMembersIfMissing (Studio v3 pre-save)', () => {
  let query: jest.Mock;
  let ensureDefaultMembership: jest.Mock;
  let service: SavedService;

  beforeEach(() => {
    query = jest.fn();
    ensureDefaultMembership = jest.fn().mockResolvedValue(undefined);
    service = new SavedService(
      { query } as unknown as Repository<SavedItem>,
      { ensureDefaultMembership } as unknown as SavedListsService,
      {} as unknown as SavedAvailabilityService,
    );
  });

  const snapshot = {
    title: 'Lisbon at four',
    href: `/studio/album?id=${RELEASE_ID}`,
    meta: 'Night Shift',
  };

  it('inserts every member in one statement and leaves an existing save untouched', async () => {
    query.mockResolvedValue([{ id: 'saved-1', user_id: FIRST_MEMBER }]);

    const savedFor = await service.saveForMembersIfMissing(
      [FIRST_MEMBER, SECOND_MEMBER],
      SavedKind.StudioRelease,
      RELEASE_ID,
      snapshot,
    );

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      'ON CONFLICT ON CONSTRAINT "UQ_saved_item_subject" DO NOTHING',
    );
    expect(sql).toMatch(/^WITH "inserted" AS \(/);
    expect(parameters).toEqual([
      [FIRST_MEMBER, SECOND_MEMBER],
      'studio_release',
      RELEASE_ID,
      'Lisbon at four',
      `/studio/album?id=${RELEASE_ID}`,
      'Night Shift',
    ]);
    expect(savedFor).toEqual([FIRST_MEMBER]);
  });

  it('files each new save in that member default list', async () => {
    query.mockResolvedValue([
      { id: 'saved-1', user_id: FIRST_MEMBER },
      { id: 'saved-2', user_id: SECOND_MEMBER },
    ]);
    await service.saveForMembersIfMissing(
      [FIRST_MEMBER, SECOND_MEMBER],
      SavedKind.StudioRelease,
      RELEASE_ID,
      snapshot,
    );
    expect(ensureDefaultMembership).toHaveBeenCalledWith(
      FIRST_MEMBER,
      'saved-1',
    );
    expect(ensureDefaultMembership).toHaveBeenCalledWith(
      SECOND_MEMBER,
      'saved-2',
    );
  });

  it('writes nothing for an empty list', async () => {
    expect(
      await service.saveForMembersIfMissing(
        [],
        SavedKind.StudioRelease,
        RELEASE_ID,
        snapshot,
      ),
    ).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps going when a default list write fails', async () => {
    query.mockResolvedValue([{ id: 'saved-1', user_id: FIRST_MEMBER }]);
    ensureDefaultMembership.mockRejectedValue(new Error('pool exhausted'));
    await expect(
      service.saveForMembersIfMissing(
        [FIRST_MEMBER],
        SavedKind.StudioRelease,
        RELEASE_ID,
        snapshot,
      ),
    ).resolves.toEqual([FIRST_MEMBER]);
  });
});
