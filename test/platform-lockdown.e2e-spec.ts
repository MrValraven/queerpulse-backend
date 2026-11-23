import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { EmailCodeEnabledGuard } from '../src/auth/email-code/email-code-enabled.guard';
import {
  EmailCodeMailer,
  SignInCodeEmail,
} from '../src/auth/email-code/email-code.mailer';
import { GoogleAuthGuard } from '../src/auth/guards/google-auth.guard';
import { encodeOAuthState } from '../src/auth/oauth-state';
import { PlatformJoinRequest } from '../src/membership/entities/join-request.entity';
import { PlatformSettingChange } from '../src/platform-settings/entities/platform-setting-change.entity';
import { PlatformSettingsService } from '../src/platform-settings/platform-settings.service';
import { User, UserRole, UserStatus } from '../src/users/entities/user.entity';

// Stub guard: read the desired Google profile from a header (same pattern as
// partners.e2e-spec.ts / companies.e2e-spec.ts / volunteering.e2e-spec.ts) so
// login works without a live round-trip to Google.
const stubGuard = {
  canActivate: (ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: unknown;
    }>();
    const raw = req.headers['x-google-profile'];
    if (raw) req.user = JSON.parse(raw) as unknown;
    return true;
  },
};

// The join-request routes (SEC-10) need a code the test can read: the mailer
// is replaced by one that keeps the last code it was handed, and the
// email-code switch is held on whatever the environment's Resend settings are.
const sentCodes: SignInCodeEmail[] = [];
const recordingMailer = {
  sendSignInCode: (email: SignInCodeEmail) => {
    sentCodes.push(email);
    return Promise.resolve({ delivered: true, emailId: null });
  },
};

describe('Platform kill switches (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(GoogleAuthGuard)
      .useValue(stubGuard)
      .overrideGuard(EmailCodeEnabledGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(EmailCodeMailer)
      .useValue(recordingMailer)
      .compile();
    app = moduleRef.createNestApplication();
    // Same as src/main.ts: req.cookies is only populated once cookie-parser is
    // registered. Without it, the oauth_state / csrf_token / access_token
    // cookies are all invisible to the app (nonce check, CsrfGuard, JwtStrategy).
    app.use(cookieParser());
    await app.init();
    ds = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  // `platform_settings` (id = 1) is a singleton INSERTed by the
  // AddPlatformSettings migration. PlatformSettingsService.get() deliberately
  // THROWS if the row is ever missing (a DB problem must not silently disable
  // the kill switch) — so, unlike every other entity in this suite, it must
  // NEVER be deleted here. Reset its columns instead, and only delete the
  // audit trail rows. Child-before-parent, users last, exactly like
  // partners.e2e-spec.ts.
  afterEach(async () => {
    await ds.query(
      `UPDATE platform_settings SET registration_enabled = true, join_requests_enabled = true, lockdown_enabled = false, lockdown_allows_moderators = false, lockdown_message = NULL, registration_closed_message = NULL WHERE id = 1`,
    );
    // The raw UPDATE above only fixes Postgres — PlatformSettingsService.get()
    // (src/platform-settings/platform-settings.service.ts) caches the row for
    // CACHE_TTL_MS (10s) and only its own update() method clears that cache.
    // Without this, a test later in the same run than 10s ago can inherit a
    // stale in-memory row (e.g. lockdownEnabled: true) from a prior test and
    // fail for a reason that has nothing to do with what it's testing. There is
    // no production-facing way to bust this from outside the service, so we
    // reach past encapsulation here deliberately — do not delete this as
    // mysterious, and do not "fix" it by adding a reset method to the service.
    const settingsService = app.get(PlatformSettingsService);
    Object.assign(settingsService as object, { cached: null, cachedAt: 0 });
    await ds.getRepository(PlatformJoinRequest).delete({});
    await ds.query(`DELETE FROM email_sign_in_challenges`);
    sentCodes.length = 0;
    await ds.getRepository(PlatformSettingChange).delete({});
    await ds.getRepository(User).delete({});
  });

  async function seedMember(
    googleId: string,
    email: string,
    role: UserRole = UserRole.Member,
  ): Promise<void> {
    await ds.getRepository(User).save(
      ds.getRepository(User).create({
        googleId,
        email,
        status: UserStatus.Active,
        role,
        activatedAt: new Date(),
      }),
    );
  }

  async function login(googleId: string, email: string): Promise<string[]> {
    // The callback (src/auth/auth.controller.ts) rejects unless the nonce
    // inside `state` matches the httpOnly `oauth_state` cookie set when the
    // flow began. In this stubbed flow we mint both ends ourselves; the nonce
    // is keyed off googleId so distinct logins in the same test never collide.
    const nonce = `e2e-nonce-${googleId}`;
    const state = encodeOAuthState({ nonce })!;
    const res = await request(app.getHttpServer() as App)
      .get('/auth/google/callback')
      .query({ state })
      .set('Cookie', [`oauth_state=${nonce}`])
      .set(
        'x-google-profile',
        JSON.stringify({
          googleId,
          email,
          firstName: 'First',
          lastName: 'Last',
          avatarUrl: null,
        }),
      );
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toContain('error=');
    return res.headers['set-cookie'] as unknown as string[];
  }

  /**
   * Double-submit CSRF (`src/security/csrf.guard.ts` +
   * `src/security/csrf.controller.ts`): fetch a token via the `@Public()`
   * `GET /csrf-token` (a safe method, so the CSRF guard itself lets it
   * through), then merge its `csrf_token` Set-Cookie into the caller's
   * session-cookie jar. Every mutating request must carry BOTH that cookie
   * and the matching `X-CSRF-Token` header.
   */
  async function withCsrf(
    sessionCookies: string[],
  ): Promise<{ cookies: string[]; csrfToken: string }> {
    const res = await request(app.getHttpServer() as App)
      .get('/csrf-token')
      .set('Cookie', sessionCookies);
    expect(res.status).toBe(200);
    const csrfToken = (res.body as { csrfToken: string }).csrfToken;
    const csrfSetCookies = res.headers['set-cookie'] as unknown as string[];
    return { cookies: [...sessionCookies, ...csrfSetCookies], csrfToken };
  }

  /** seedMember + login + withCsrf, in the order the token signing requires. */
  async function signInAs(
    googleId: string,
    email: string,
    role: UserRole,
  ): Promise<{ cookies: string[]; csrfToken: string }> {
    // Role is baked into the JWT at login time (`AuthService` signs `role` off
    // the DB row as it stood at login), so the role must be seeded BEFORE the
    // oauth callback mints the tokens, not patched onto the User row after.
    await seedMember(googleId, email, role);
    const cookies = await login(googleId, email);
    return withCsrf(cookies);
  }

  /**
   * Drives `GET /auth/google/callback` WITHOUT asserting success — the
   * registration tests need to inspect a rejection redirect, which `login()`
   * asserts against. Returns the raw supertest response.
   */
  async function attemptGoogleSignup(googleId: string, email: string) {
    const nonce = `e2e-nonce-${googleId}`;
    const state = encodeOAuthState({ nonce })!;
    return request(app.getHttpServer() as App)
      .get('/auth/google/callback')
      .query({ state })
      .set('Cookie', [`oauth_state=${nonce}`])
      .set(
        'x-google-profile',
        JSON.stringify({
          googleId,
          email,
          firstName: 'First',
          lastName: 'Last',
          avatarUrl: null,
        }),
      );
  }

  /**
   * Flips flags through the real admin endpoint rather than a raw SQL UPDATE.
   * `PlatformSettingsService.get()` caches the settings row for 10s
   * (CACHE_TTL_MS in platform-settings.service.ts) and only `update()` busts
   * that cache — a direct SQL write would not be observed by the running app
   * until the TTL expired, which would make an immediately-following
   * assertion flaky/wrong. This both exercises the real write path and keeps
   * the cache honest.
   */
  async function setFlags(
    admin: { cookies: string[]; csrfToken: string },
    flags: Record<string, boolean | string | null>,
  ): Promise<void> {
    await request(app.getHttpServer() as App)
      .patch('/admin/platform-settings')
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrfToken)
      .send(flags)
      .expect(200);
  }

  describe('lockdown', () => {
    it('serves a member normally when unlocked', async () => {
      // Deliberately the same route the locked tests below hit (/connections),
      // not /auth/me — AuthController is @LockdownExempt() at class level, so
      // it would bypass PlatformLockdownGuard whether locked or not and prove
      // nothing as a before/after baseline.
      const member = await signInAs(
        'm-1',
        'member@example.com',
        UserRole.Member,
      );
      await request(app.getHttpServer() as App)
        .get('/connections')
        .set('Cookie', member.cookies)
        .expect(200);
    });

    it('returns 503 PLATFORM_LOCKED to a member while locked', async () => {
      const admin = await signInAs('a-1', 'admin@example.com', UserRole.Admin);
      const member = await signInAs(
        'm-1',
        'member@example.com',
        UserRole.Member,
      );
      await setFlags(admin, {
        lockdownEnabled: true,
        lockdownMessage: 'Back soon.',
      });

      const res = await request(app.getHttpServer() as App)
        .get('/connections')
        .set('Cookie', member.cookies)
        .expect(503);

      expect(res.body).toMatchObject({
        code: 'PLATFORM_LOCKED',
        message: 'Back soon.',
      });
    });

    it('serves an admin the same route while locked', async () => {
      const admin = await signInAs('a-1', 'admin@example.com', UserRole.Admin);
      await setFlags(admin, { lockdownEnabled: true });

      await request(app.getHttpServer() as App)
        .get('/connections')
        .set('Cookie', admin.cookies)
        .expect(200);
    });

    it('lets an admin lift the lockdown while it is active', async () => {
      // The self-lockout guarantee: if this fails, enabling lockdown is a
      // one-way door and the only recovery is a manual database edit.
      const admin = await signInAs('a-1', 'admin@example.com', UserRole.Admin);
      const member = await signInAs(
        'm-1',
        'member@example.com',
        UserRole.Member,
      );
      await setFlags(admin, { lockdownEnabled: true });

      // Prove the platform was actually locked before lifting it — otherwise a
      // silent no-op in setFlags(true) would still let this test pass.
      await request(app.getHttpServer() as App)
        .get('/connections')
        .set('Cookie', member.cookies)
        .expect(503);

      await setFlags(admin, { lockdownEnabled: false });

      await request(app.getHttpServer() as App)
        .get('/connections')
        .set('Cookie', member.cookies)
        .expect(200);
    });

    it('keeps /platform-status and /health reachable while locked', async () => {
      const admin = await signInAs('a-1', 'admin@example.com', UserRole.Admin);
      await setFlags(admin, { lockdownEnabled: true });

      await request(app.getHttpServer() as App)
        .get('/platform-status')
        .expect(200);
      await request(app.getHttpServer() as App)
        .get('/health')
        .expect(200);
    });

    it('blocks a moderator while locked when moderators are not allowed', async () => {
      const admin = await signInAs('a-1', 'admin@example.com', UserRole.Admin);
      const mod = await signInAs('o-1', 'mod@example.com', UserRole.Moderator);
      await setFlags(admin, {
        lockdownEnabled: true,
        lockdownAllowsModerators: false,
      });

      await request(app.getHttpServer() as App)
        .get('/connections')
        .set('Cookie', mod.cookies)
        .expect(503);
    });

    it('allows a moderator while locked when moderators are allowed', async () => {
      const admin = await signInAs('a-1', 'admin@example.com', UserRole.Admin);
      const mod = await signInAs('o-1', 'mod@example.com', UserRole.Moderator);
      await setFlags(admin, {
        lockdownEnabled: true,
        lockdownAllowsModerators: true,
      });

      await request(app.getHttpServer() as App)
        .get('/connections')
        .set('Cookie', mod.cookies)
        .expect(200);
    });
  });

  describe('join requests', () => {
    // SEC-10: filing takes two public POSTs under /auth/email-code (the
    // requester cookie is scoped to /auth). Both are @Public() and both still
    // pass the global CsrfGuard, so each carries a token from /csrf-token.
    const FORM = {
      name: 'Ada',
      message: 'I would love to join the community.',
      ageAttested: true,
      termsVersion: '1.0',
      heardFrom: 'A friend',
    };

    it('files a request once the emailed code is typed back', async () => {
      const { cookies, csrfToken } = await withCsrf([]);
      const asked = await request(app.getHttpServer() as App)
        .post('/auth/email-code/join-request/request')
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrfToken)
        .send({ email: 'ada@example.com' })
        .expect(200);
      const { challengeId } = asked.body as { challengeId: string };
      const requesterCookies = asked.headers[
        'set-cookie'
      ] as unknown as string[];
      const code = sentCodes.at(-1)?.code;
      expect(code).toMatch(/^\d{6}$/);

      const filed = await request(app.getHttpServer() as App)
        .post('/auth/email-code/join-request/verify')
        .set('Cookie', [...cookies, ...requesterCookies])
        .set('X-CSRF-Token', csrfToken)
        .send({ ...FORM, challengeId, code })
        .expect(201);

      expect(filed.body).toEqual(
        expect.objectContaining({ statusToken: expect.any(String) as unknown }),
      );
      const rows = await ds.getRepository(PlatformJoinRequest).find();
      expect(rows.map((row) => row.email)).toEqual(['ada@example.com']);
    });

    it('files nothing for a wrong code', async () => {
      const { cookies, csrfToken } = await withCsrf([]);
      const asked = await request(app.getHttpServer() as App)
        .post('/auth/email-code/join-request/request')
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrfToken)
        .send({ email: 'ada@example.com' })
        .expect(200);
      const { challengeId } = asked.body as { challengeId: string };
      const requesterCookies = asked.headers[
        'set-cookie'
      ] as unknown as string[];
      const wrongCode =
        sentCodes.at(-1)?.code === '000000' ? '111111' : '000000';

      const res = await request(app.getHttpServer() as App)
        .post('/auth/email-code/join-request/verify')
        .set('Cookie', [...cookies, ...requesterCookies])
        .set('X-CSRF-Token', csrfToken)
        .send({ ...FORM, challengeId, code: wrongCode })
        .expect(400);

      expect((res.body as { reason: string }).reason).toBe('code_incorrect');
      expect(await ds.getRepository(PlatformJoinRequest).count()).toBe(0);
    });

    it('returns 403 JOIN_REQUESTS_CLOSED and sends no code when the switch is off', async () => {
      const admin = await signInAs('a-1', 'admin@example.com', UserRole.Admin);
      await setFlags(admin, {
        joinRequestsEnabled: false,
        registrationClosedMessage: 'Paused while we clear out spam.',
      });

      const { cookies, csrfToken } = await withCsrf([]);
      const res = await request(app.getHttpServer() as App)
        .post('/auth/email-code/join-request/request')
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrfToken)
        .send({ email: 'ada@example.com' })
        .expect(403);

      const body = res.body as { code: string; message: string };
      expect(body.code).toBe('JOIN_REQUESTS_CLOSED');
      expect(body.message).toBe('Paused while we clear out spam.');
      expect(sentCodes).toHaveLength(0);
    });
  });

  describe('registration', () => {
    it('rejects a brand-new Google signup when registration is off', async () => {
      const admin = await signInAs('a-1', 'admin@example.com', UserRole.Admin);
      await setFlags(admin, { registrationEnabled: false });

      // A never-seen googleId: the redirect must carry the
      // registration_disabled reason rather than creating the account. No
      // invite is supplied — with registration off, AuthService checks
      // registrationEnabled before invite_required, so none is needed.
      const res = await attemptGoogleSignup('brand-new', 'new@example.com');

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=registration_disabled');
    });

    it('still signs in a returning member when registration is off', async () => {
      const admin = await signInAs('a-1', 'admin@example.com', UserRole.Admin);
      await seedMember('m-1', 'member@example.com', UserRole.Member);
      await setFlags(admin, { registrationEnabled: false });

      const res = await attemptGoogleSignup('m-1', 'member@example.com');

      expect(res.status).toBe(302);
      expect(res.headers.location).not.toContain('error=');
    });
  });

  describe('admin API access', () => {
    it('refuses a member', async () => {
      const member = await signInAs(
        'm-1',
        'member@example.com',
        UserRole.Member,
      );
      await request(app.getHttpServer() as App)
        .get('/admin/platform-settings')
        .set('Cookie', member.cookies)
        .expect(403);
    });

    it('refuses a moderator — these controls are admin-only', async () => {
      const mod = await signInAs('o-1', 'mod@example.com', UserRole.Moderator);
      await request(app.getHttpServer() as App)
        .get('/admin/platform-settings')
        .set('Cookie', mod.cookies)
        .expect(403);
    });

    it('records one audit row per changed field', async () => {
      const admin = await signInAs('a-1', 'admin@example.com', UserRole.Admin);
      await setFlags(admin, {
        lockdownEnabled: true,
        joinRequestsEnabled: false,
        note: 'spam wave',
      });

      const res = await request(app.getHttpServer() as App)
        .get('/admin/platform-settings/changes')
        .set('Cookie', admin.cookies)
        .expect(200);

      const body = res.body as {
        settingKey: string;
        note: string | null;
        actorId: string;
      }[];
      expect(body).toHaveLength(2);
      expect(body.map((c) => c.settingKey).sort()).toEqual([
        'joinRequestsEnabled',
        'lockdownEnabled',
      ]);
      expect(body.every((c) => c.note === 'spam wave')).toBe(true);

      // Attribution is the point of the audit trail: every row must be
      // attributed to the admin who actually made the change.
      const adminUser = await ds
        .getRepository(User)
        .findOne({ where: { googleId: 'a-1' } });
      if (!adminUser) {
        throw new Error('no seeded user for googleId "a-1"');
      }
      expect(body.every((c) => c.actorId === adminUser.id)).toBe(true);
    });
  });
});
