import { INestApplication } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { GoogleAuthGuard } from '../src/auth/guards/google-auth.guard';
import { User, UserStatus, UserRole } from '../src/users/entities/user.entity';
import { Profile } from '../src/users/entities/profile.entity';
import { Invite, InviteStatus } from '../src/membership/entities/invite.entity';

// Stub guard: read the desired Google profile + invite code from headers.
// Replaces the real GoogleAuthGuard (which does a live OAuth round-trip)
// so the test exercises controller → service → DB without touching Google.
const stubGuard = {
  canActivate: (ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    const raw = req.headers['x-google-profile'];
    if (raw) req.user = JSON.parse(raw);
    const state = req.headers['x-invite-state'];
    if (state) req.query.state = state;
    return true;
  },
};

describe('Invite-gated Google sign-in (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(GoogleAuthGuard)
      .useValue(stubGuard)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    ds = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(async () => {
    // Clean tables touched by these tests (profile CASCADE-deletes from User,
    // but we delete explicitly in case there are rows without a profile).
    await ds.getRepository(Profile).delete({});
    await ds.getRepository(Invite).delete({});
    await ds.getRepository(User).delete({});
  });

  /**
   * Helper: build the JSON header value that the stub guard parses into req.user.
   * Matches the GoogleUserInput interface consumed by AuthService.
   */
  const profile = (over: Partial<Record<string, string | null>> = {}) =>
    JSON.stringify({
      googleId: 'g-new',
      email: 'newbie@example.com',
      firstName: 'New',
      lastName: 'Bie',
      avatarUrl: null,
      ...over,
    });

  // -------------------------------------------------------------------------
  // Scenario 1: unknown email, no invite → 302 + error=invite_required, no row
  // -------------------------------------------------------------------------
  it('rejects an unknown email with no invite: redirect + no user row', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/google/callback')
      .set('x-google-profile', profile());

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=invite_required');

    const count = await ds.getRepository(User).count();
    expect(count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 2: unknown email + valid pending invite → Active user + consumed
  // -------------------------------------------------------------------------
  it('accepts an unknown email with a valid invite: Active user + consumed invite', async () => {
    // Seed an inviter
    const inviter = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        googleId: 'g-inviter',
        email: 'inviter@example.com',
        status: UserStatus.Active,
        role: UserRole.Member,
        activatedAt: new Date(),
      }),
    );

    // Seed a valid (pending, not-yet-expired) invite
    await ds.getRepository(Invite).save(
      ds.getRepository(Invite).create({
        inviterId: inviter.id,
        code: 'GOODCODE',
        email: null,
        status: InviteStatus.Pending,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );

    const res = await request(app.getHttpServer())
      .get('/auth/google/callback')
      .set('x-google-profile', profile())
      .set('x-invite-state', 'GOODCODE');

    expect(res.status).toBe(302);
    expect(res.headers.location).not.toContain('error=');

    // New user must be Active and attributed to the inviter (spec §3)
    const created = await ds
      .getRepository(User)
      .findOne({ where: { googleId: 'g-new' }, relations: { invitedBy: true } });
    expect(created).not.toBeNull();
    expect(created?.status).toBe(UserStatus.Active);
    expect(created?.invitedBy?.id).toBe(inviter.id);

    // Invite must be marked Accepted and reference the new user
    const invite = await ds
      .getRepository(Invite)
      .findOne({ where: { code: 'GOODCODE' } });
    expect(invite?.status).toBe(InviteStatus.Accepted);
    expect(invite?.acceptedBy).toBe(created?.id);
  });

  // -------------------------------------------------------------------------
  // Scenario 3: returning Google user (existing googleId) → 302, no error
  // -------------------------------------------------------------------------
  it('lets a returning user sign in without an invite', async () => {
    // Seed the existing user
    await ds.getRepository(User).save(
      ds.getRepository(User).create({
        googleId: 'g-return',
        email: 'return@example.com',
        status: UserStatus.Active,
        role: UserRole.Member,
        activatedAt: new Date(),
      }),
    );

    const res = await request(app.getHttpServer())
      .get('/auth/google/callback')
      .set(
        'x-google-profile',
        profile({ googleId: 'g-return', email: 'return@example.com' }),
      );

    expect(res.status).toBe(302);
    expect(res.headers.location).not.toContain('error=');
  });

  // -------------------------------------------------------------------------
  // Scenario 4: expired invite → 302 + error=invite_invalid, only inviter row
  // -------------------------------------------------------------------------
  it('rejects an expired invite with error=invite_invalid', async () => {
    const inviter = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        googleId: 'g-inviter2',
        email: 'inviter2@example.com',
        status: UserStatus.Active,
        role: UserRole.Member,
        activatedAt: new Date(),
      }),
    );

    await ds.getRepository(Invite).save(
      ds.getRepository(Invite).create({
        inviterId: inviter.id,
        code: 'EXPIRED',
        email: null,
        status: InviteStatus.Pending,
        expiresAt: new Date(Date.now() - 60_000), // in the past
      }),
    );

    const res = await request(app.getHttpServer())
      .get('/auth/google/callback')
      .set('x-google-profile', profile())
      .set('x-invite-state', 'EXPIRED');

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('error=invite_invalid');

    // No new user should have been created; only the inviter row exists
    const count = await ds.getRepository(User).count();
    expect(count).toBe(1); // only the inviter
  });
});
