import { ExecutionContext, HttpException } from '@nestjs/common';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioAccessService } from './studio-access.service';

const contextFor = (user: { userId: string } | undefined) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
}

describe('StudioAccessGuard', () => {
  let access: { hasAccess: jest.Mock };
  let guard: StudioAccessGuard;

  beforeEach(() => {
    access = { hasAccess: jest.fn().mockResolvedValue(true) };
    guard = new StudioAccessGuard(access as unknown as StudioAccessService);
  });

  it('lets a granted member through', async () => {
    await expect(
      guard.canActivate(contextFor({ userId: 'member-1' })),
    ).resolves.toBe(true);
    expect(access.hasAccess).toHaveBeenCalledWith('member-1');
  });

  it('refuses once the grant is revoked', async () => {
    access.hasAccess.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await guard.canActivate(contextFor({ userId: 'member-1' }));
    expect(
      await codeOf(guard.canActivate(contextFor({ userId: 'member-1' }))),
    ).toBe('studio_access_required');
  });

  it('refuses a request with no signed-in member', async () => {
    expect(await codeOf(guard.canActivate(contextFor(undefined)))).toBe(
      'studio_access_required',
    );
    expect(access.hasAccess).not.toHaveBeenCalled();
  });
});
