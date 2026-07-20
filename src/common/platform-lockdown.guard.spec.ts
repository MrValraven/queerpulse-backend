import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../users/entities/user.entity';
import { PlatformSettings } from '../platform-settings/entities/platform-settings.entity';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { LockdownExempt } from './lockdown-exempt.decorator';
import { PlatformLockdownGuard } from './platform-lockdown.guard';

type Flags = Partial<
  Pick<
    PlatformSettings,
    'lockdownEnabled' | 'lockdownAllowsModerators' | 'lockdownMessage'
  >
>;

// Real classes exercised through a real Reflector, so metadata resolution is
// proven end to end instead of stubbed out. `@LockdownExempt()` is applied at
// the class level (mirroring the real auth/csrf/health controllers), and the
// handler used below is a plain undecorated method — exactly how Nest passes
// `[context.getHandler(), context.getClass()]` to `getAllAndOverride` in
// production, where class-level metadata is only picked up via the class arg.
@LockdownExempt()
class ExemptTestController {
  handler(): void {}
}

class NonExemptTestController {
  handler(): void {}
}

function makeGuard(options: {
  flags?: Flags;
  exempt?: boolean;
  role?: UserRole;
  type?: 'http' | 'ws';
}) {
  const settings = {
    get: jest.fn().mockResolvedValue({
      lockdownEnabled: false,
      lockdownAllowsModerators: false,
      lockdownMessage: null,
      ...options.flags,
    }),
  } as unknown as PlatformSettingsService;

  const reflector = new Reflector();

  const targetClass = options.exempt
    ? ExemptTestController
    : NonExemptTestController;

  const context = {
    getType: () => options.type ?? 'http',
    getHandler: () => targetClass.prototype.handler,
    getClass: () => targetClass,
    switchToHttp: () => ({
      getRequest: () => ({
        user: options.role ? { role: options.role } : undefined,
      }),
    }),
  } as unknown as ExecutionContext;

  return {
    guard: new PlatformLockdownGuard(reflector, settings),
    context,
    settings,
  };
}

describe('PlatformLockdownGuard', () => {
  afterEach(() => jest.clearAllMocks());

  it('allows everything when lockdown is off', async () => {
    const { guard, context } = makeGuard({
      flags: { lockdownEnabled: false },
      role: UserRole.Member,
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('allows non-HTTP contexts without reading the settings', async () => {
    // WebSockets authenticate in ChatGateway.handleConnection, which runs its
    // own lockdown check; this guard must not try to read an HTTP request that
    // does not exist.
    const { guard, context, settings } = makeGuard({
      type: 'ws',
      flags: { lockdownEnabled: true },
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(settings.get).not.toHaveBeenCalled();
  });

  it('allows an exempt route while locked, even with no user', async () => {
    const { guard, context } = makeGuard({
      exempt: true,
      flags: { lockdownEnabled: true },
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('allows an admin while locked', async () => {
    const { guard, context } = makeGuard({
      flags: { lockdownEnabled: true },
      role: UserRole.Admin,
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('blocks a moderator while locked when moderators are not allowed', async () => {
    const { guard, context } = makeGuard({
      flags: { lockdownEnabled: true, lockdownAllowsModerators: false },
      role: UserRole.Moderator,
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('allows a moderator while locked when moderators are allowed', async () => {
    const { guard, context } = makeGuard({
      flags: { lockdownEnabled: true, lockdownAllowsModerators: true },
      role: UserRole.Moderator,
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('blocks a member while locked even when moderators are allowed', async () => {
    const { guard, context } = makeGuard({
      flags: { lockdownEnabled: true, lockdownAllowsModerators: true },
      role: UserRole.Member,
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('blocks an unauthenticated caller on a non-exempt route while locked', async () => {
    const { guard, context } = makeGuard({ flags: { lockdownEnabled: true } });
    await expect(guard.canActivate(context)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('rejects with 503 and code PLATFORM_LOCKED carrying the admin message', async () => {
    const { guard, context } = makeGuard({
      flags: { lockdownEnabled: true, lockdownMessage: 'Back in an hour.' },
      role: UserRole.Member,
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 503,
      response: {
        code: 'PLATFORM_LOCKED',
        message: 'Back in an hour.',
      },
    });
  });

  it('falls back to default copy when no message is set', async () => {
    const { guard, context } = makeGuard({
      flags: { lockdownEnabled: true, lockdownMessage: null },
      role: UserRole.Member,
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { message: expect.stringContaining('temporarily unavailable') },
    });
  });

  it('falls back to default copy when the message is an empty string', async () => {
    // An admin who clears the message textarea sends '', which `??` would let
    // through as a "message" — the member would get a blank maintenance screen.
    const { guard, context } = makeGuard({
      flags: { lockdownEnabled: true, lockdownMessage: '' },
      role: UserRole.Member,
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { message: expect.stringContaining('temporarily unavailable') },
    });
  });
});
