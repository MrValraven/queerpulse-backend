import { EntityManager } from 'typeorm';
import {
  FILE_STUDIO_ACCESS_REQUEST_SQL,
  fileStudioAccessRequestForInvite,
} from './studio-access-request-filing';

describe('fileStudioAccessRequestForInvite', () => {
  const INVITE_ID = 'fb000000-0000-4000-8000-000000000001';
  const USER_ID = 'fb000000-0000-4000-8000-000000000002';

  it('files the request from the join request sources in one statement', async () => {
    const query = jest
      .fn<Promise<unknown>, [string, unknown[]?]>()
      .mockResolvedValue(undefined);
    const manager = { query } as unknown as EntityManager;

    await fileStudioAccessRequestForInvite(manager, INVITE_ID, USER_ID);

    expect(query.mock.calls).toEqual([
      [FILE_STUDIO_ACCESS_REQUEST_SQL, [INVITE_ID, USER_ID]],
    ]);
    expect(FILE_STUDIO_ACCESS_REQUEST_SQL).toContain(
      `bool_or("join_request"."source" = 'studio_artist')`,
    );
    expect(FILE_STUDIO_ACCESS_REQUEST_SQL).toContain(
      `IN ('studio_landing', 'studio_artist')`,
    );
    expect(FILE_STUDIO_ACCESS_REQUEST_SQL).toContain('HAVING count(*) > 0');
    expect(FILE_STUDIO_ACCESS_REQUEST_SQL).toContain(
      'ON CONFLICT ("user_id") DO NOTHING',
    );
  });
});
