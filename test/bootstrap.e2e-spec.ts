import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { GoogleAuthGuard } from '../src/auth/guards/google-auth.guard';
import { encodeOAuthState } from '../src/auth/oauth-state';
import { Block } from '../src/social/entities/block.entity';
import { Profile } from '../src/users/entities/profile.entity';
import { User, UserRole, UserStatus } from '../src/users/entities/user.entity';

// Stub guard: read the desired Google profile from a header (same pattern as
// jobs.e2e-spec.ts / companies.e2e-spec.ts / communities.e2e-spec.ts) so
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

describe('Bootstrap (e2e)', () => {
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

  // FK-safe order: blocks and profiles before their users (mirrors
  // auth-invite-gate.e2e-spec.ts's teardown — both FKs carry ON DELETE
  // CASCADE from users.id, per AddBlocksMutes1782800010000 /
  // the profiles migration, but every other suite in this repo deletes
  // children explicitly rather than relying on it). Mutes/saved are never
  // seeded by this file, only listed, so there is nothing to clean there.
  afterEach(async () => {
    await ds.getRepository(Block).delete({});
    await ds.getRepository(Profile).delete({});
    await ds.getRepository(User).delete({});
  });

  /**
   * Seeds an Active user AND its profile row directly.
   *
   * Deviation from jobs.e2e-spec.ts's `seedActiveMember`: that helper only
   * inserts a `users` row because Jobs never touches profiles. `GET
   * /me/bootstrap` fans out to `ProfilesService.getMine`
   * (src/profiles/profiles.service.ts), which throws `NotFoundException` when
   * no `profiles` row exists for the user — and a `profiles` row is normally
   * only created by `UsersService.createGoogleUser` on the real invite-signup
   * path (src/users/users.service.ts), which this stubbed-OAuth harness never
   * drives. So this helper inserts the profile row directly too, the same four
   * columns `createGoogleUser` sets (userId, slug, firstName, lastName),
   * leaving everything else to the column defaults — deliberately skipping the
   * `handles` registry insert that the real path also does, since no test here
   * exercises username/handle behaviour.
   */
  async function seedActiveMemberWithProfile(
    googleId: string,
    email: string,
    slug: string,
  ): Promise<void> {
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        googleId,
        email,
        status: UserStatus.Active,
        role: UserRole.Member,
        activatedAt: new Date(),
      }),
    );
    await ds.getRepository(Profile).save(
      ds.getRepository(Profile).create({
        userId: user.id,
        slug,
        firstName: 'First',
        lastName: 'Last',
      }),
    );
  }

  /**
   * Seeds a Suspended user — the basis for the 403 test. `ActiveMemberGuard`
   * (src/auth/guards/active-member.guard.ts) 403s on any
   * `user.status !== UserStatus.Active`; there is no `Pending` status in this
   * codebase (see the comment on `UserStatus` in
   * src/users/entities/user.entity.ts — a non-member has no `users` row at
   * all), so `Suspended` is the real, existing non-active state to assert
   * against rather than an invented one. No profile row: the guard rejects
   * before the controller ever reaches `ProfilesService.getMine`.
   */
  async function seedSuspendedMember(
    googleId: string,
    email: string,
  ): Promise<void> {
    await ds.getRepository(User).save(
      ds.getRepository(User).create({
        googleId,
        email,
        status: UserStatus.Suspended,
        role: UserRole.Member,
        activatedAt: new Date(),
      }),
    );
  }

  /**
   * Logs in an already-seeded user via the stubbed OAuth callback. Split out
   * from seeding (unlike jobs.e2e-spec.ts's combined `loginAsActiveMember`)
   * because this file needs two different seed shapes — active-with-profile
   * and suspended-without-profile — sharing one login step.
   */
  async function loginAs(googleId: string, email: string): Promise<string[]> {
    // The callback (src/auth/auth.controller.ts) rejects unless the nonce
    // inside `state` matches the httpOnly `oauth_state` cookie set when the
    // flow began. In this stubbed flow we mint both ends ourselves; the nonce
    // is keyed off googleId so distinct logins in the same test never collide.
    const nonce = `e2e-nonce-${googleId}`;
    const state = encodeOAuthState({ nonce })!;
    const res = await request(app.getHttpServer())
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
   * `src/security/csrf.controller.ts`), copied from jobs.e2e-spec.ts /
   * platform-lockdown.e2e-spec.ts: fetch a token via the `@Public()`
   * `GET /csrf-token` (a safe method, so the CSRF guard itself lets it
   * through), then merge its `csrf_token` Set-Cookie into the caller's
   * session-cookie jar. Every mutating request must carry BOTH that cookie
   * and the matching `X-CSRF-Token` header. Needed here because seeding the
   * block for the parity test below goes through the real, CSRF-guarded
   * `POST /blocks/:slug` route rather than a direct row insert.
   */
  async function withCsrf(
    sessionCookies: string[],
  ): Promise<{ cookies: string[]; csrfToken: string }> {
    const res = await request(app.getHttpServer())
      .get('/csrf-token')
      .set('Cookie', sessionCookies);
    expect(res.status).toBe(200);
    const csrfToken = (res.body as { csrfToken: string }).csrfToken;
    const csrfSetCookies = res.headers['set-cookie'] as unknown as string[];
    return { cookies: [...sessionCookies, ...csrfSetCookies], csrfToken };
  }

  it('returns all four slices for an active member', async () => {
    await seedActiveMemberWithProfile(
      'g-bootstrap-1',
      'bootstrap1@example.com',
      'bootstrap-member-1',
    );
    const cookies = await loginAs('g-bootstrap-1', 'bootstrap1@example.com');

    const res = await request(app.getHttpServer())
      .get('/me/bootstrap')
      .set('Cookie', cookies)
      .expect(200);

    expect(Object.keys(res.body as object).sort()).toEqual([
      'blocks',
      'mutes',
      'profile',
      'saved',
    ]);
    const body = res.body as {
      profile: { slug: string };
      saved: { page: number; pageSize: number; items: unknown[] };
      blocks: { page: number; pageSize: number; items: unknown[] };
      mutes: { page: number; pageSize: number; items: unknown[] };
    };
    expect(body.profile.slug).toBe('bootstrap-member-1');
    for (const slice of ['saved', 'blocks', 'mutes'] as const) {
      expect(body[slice]).toMatchObject({ page: 1, pageSize: 20 });
      expect(Array.isArray(body[slice].items)).toBe(true);
    }
  });

  // The important test: this is what stops the bootstrap envelope drifting
  // from the standalone endpoint it is meant to mirror, which is the
  // assumption the whole frontend cache-seeding design rests on. A block is
  // seeded through the real POST /blocks/:slug route (not a direct row
  // insert) specifically so both GETs below are comparing data the app
  // itself produced — with an empty blocks list this test would pass even if
  // the two read paths diverged in field mapping, ordering, or pagination,
  // which is exactly the drift it exists to catch.
  it('matches what the standalone /blocks endpoint returns', async () => {
    await seedActiveMemberWithProfile(
      'g-bootstrap-2',
      'bootstrap2@example.com',
      'bootstrap-member-2',
    );
    await seedActiveMemberWithProfile(
      'g-bootstrap-2-target',
      'bootstrap2-target@example.com',
      'bootstrap-member-2-target',
    );
    const sessionCookies = await loginAs(
      'g-bootstrap-2',
      'bootstrap2@example.com',
    );
    const { cookies, csrfToken } = await withCsrf(sessionCookies);

    await request(app.getHttpServer())
      .post('/blocks/bootstrap-member-2-target')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .expect(201);

    const bootstrap = await request(app.getHttpServer())
      .get('/me/bootstrap')
      .set('Cookie', cookies)
      .expect(200);
    const blocks = await request(app.getHttpServer())
      .get('/blocks')
      .set('Cookie', cookies)
      .expect(200);

    const bootstrapBody = bootstrap.body as { blocks: { items: unknown[] } };
    // Guards against the fixture silently going back to empty (which would
    // make the toEqual below vacuous again).
    expect(bootstrapBody.blocks.items).toHaveLength(1);
    expect(bootstrapBody.blocks).toEqual(blocks.body as unknown);
  });

  it('403s for a non-active (suspended) member', async () => {
    await seedSuspendedMember('g-bootstrap-3', 'bootstrap3@example.com');
    const cookies = await loginAs('g-bootstrap-3', 'bootstrap3@example.com');

    await request(app.getHttpServer())
      .get('/me/bootstrap')
      .set('Cookie', cookies)
      .expect(403);
  });
});
