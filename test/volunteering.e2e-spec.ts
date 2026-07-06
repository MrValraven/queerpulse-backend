import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { GoogleAuthGuard } from '../src/auth/guards/google-auth.guard';
import { encodeOAuthState } from '../src/auth/oauth-state';
import { User, UserRole, UserStatus } from '../src/users/entities/user.entity';
import { VolunteerOpportunityTeam } from '../src/volunteering/entities/volunteer-opportunity-team.entity';
import { VolunteerOpportunity } from '../src/volunteering/entities/volunteer-opportunity.entity';
import { VolunteerSignup } from '../src/volunteering/entities/volunteer-signup.entity';

// Stub guard: read the desired Google profile from a header (same pattern as
// companies.e2e-spec.ts / communities.e2e-spec.ts) so login works without a
// live round-trip to Google.
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

describe('Volunteering (e2e)', () => {
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

  // FK-safe order: signups/team rows before the opportunity parent, users
  // last (mirrors companies.e2e-spec.ts's teardown discipline; guarded by
  // test/db-safety.ts against ever running outside a *_test database).
  afterEach(async () => {
    await ds.getRepository(VolunteerSignup).delete({});
    await ds.getRepository(VolunteerOpportunityTeam).delete({});
    await ds.getRepository(VolunteerOpportunity).delete({});
    await ds.getRepository(User).delete({});
  });

  async function seedActiveMember(
    googleId: string,
    email: string,
  ): Promise<void> {
    await ds.getRepository(User).save(
      ds.getRepository(User).create({
        googleId,
        email,
        status: UserStatus.Active,
        role: UserRole.Member,
        activatedAt: new Date(),
      }),
    );
  }

  async function loginAsActiveMember(
    googleId: string,
    email: string,
  ): Promise<string[]> {
    await seedActiveMember(googleId, email);
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
   * `src/security/csrf.controller.ts`): fetch a token via the `@Public()`
   * `GET /csrf-token` (a safe method, so the CSRF guard itself lets it
   * through), then merge its `csrf_token` Set-Cookie into the caller's
   * session-cookie jar. Every mutating request must carry BOTH that cookie
   * and the matching `X-CSRF-Token` header.
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

  function createOpportunityPayload(handle: string, spotsTotal = 2) {
    return {
      org: 'Queer Youth Collective',
      role: 'Mentor',
      cause: 'youth',
      commit: 'low',
      time: '2 hrs / week',
      location: 'Lisbon',
      desc: 'Mentor queer youth navigating school and family.',
      spotsTotal,
      applyRole: 'Volunteer Coordinator',
      handle,
    };
  }

  async function createOpportunity(
    cookies: string[],
    csrfToken: string,
    handle: string,
    spotsTotal = 2,
  ): Promise<{ slug: string; org: string }> {
    const res = await request(app.getHttpServer())
      .post('/volunteering')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .send(createOpportunityPayload(handle, spotsTotal));
    expect(res.status).toBe(201);
    return res.body as { slug: string; org: string };
  }

  it('rejects unauthenticated access to the volunteering list', async () => {
    const res = await request(app.getHttpServer()).get('/volunteering');
    expect(res.status).toBe(401);
  });

  it('lets an active member create an opportunity (CSRF-guarded POST), storing partner: null', async () => {
    const posterCookies = await loginAsActiveMember(
      'g-volunteering-poster-1',
      'poster1@example.com',
    );
    const { cookies, csrfToken } = await withCsrf(posterCookies);

    const res = await request(app.getHttpServer())
      .post('/volunteering')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .send(createOpportunityPayload('mentor-qyc-1'));

    expect(res.status).toBe(201);
    const body = res.body as {
      slug: string;
      org: string;
      partner: unknown;
      isPoster: boolean;
      spotsFilled: number;
      spotsPct: number;
    };
    expect(body.slug).toBe('mentor-qyc-1');
    expect(body.org).toBe('Queer Youth Collective');
    expect(body.partner).toBeNull();
    expect(body.isPoster).toBe(true);
    expect(body.spotsFilled).toBe(0);
    expect(body.spotsPct).toBe(0);
  });

  it('shows a created opportunity by slug', async () => {
    const posterCookies = await loginAsActiveMember(
      'g-volunteering-poster-2',
      'poster2@example.com',
    );
    const { cookies, csrfToken } = await withCsrf(posterCookies);
    const created = await createOpportunity(cookies, csrfToken, 'mentor-qyc-2');

    const res = await request(app.getHttpServer())
      .get(`/volunteering/${created.slug}`)
      .set('Cookie', posterCookies);

    expect(res.status).toBe(200);
    const body = res.body as { slug: string; org: string };
    expect(body.slug).toBe(created.slug);
    expect(body.org).toBe('Queer Youth Collective');
  });

  it('signs members up until capacity, then 409s the over-capacity signup', async () => {
    const posterCookies = await loginAsActiveMember(
      'g-volunteering-poster-3',
      'poster3@example.com',
    );
    const { cookies: posterCsrfCookies, csrfToken: posterCsrfToken } =
      await withCsrf(posterCookies);
    const created = await createOpportunity(
      posterCsrfCookies,
      posterCsrfToken,
      'mentor-qyc-3',
      1, // spotsTotal: 1 — the very next signup should be over capacity
    );

    const firstCookies = await loginAsActiveMember(
      'g-volunteering-signup-3a',
      'signup3a@example.com',
    );
    const { cookies: firstCsrfCookies, csrfToken: firstCsrfToken } =
      await withCsrf(firstCookies);
    const firstRes = await request(app.getHttpServer())
      .post(`/volunteering/${created.slug}/signups`)
      .set('Cookie', firstCsrfCookies)
      .set('X-CSRF-Token', firstCsrfToken)
      .send({ note: 'Excited to help!' });
    expect(firstRes.status).toBe(201);

    const secondCookies = await loginAsActiveMember(
      'g-volunteering-signup-3b',
      'signup3b@example.com',
    );
    const { cookies: secondCsrfCookies, csrfToken: secondCsrfToken } =
      await withCsrf(secondCookies);
    const secondRes = await request(app.getHttpServer())
      .post(`/volunteering/${created.slug}/signups`)
      .set('Cookie', secondCsrfCookies)
      .set('X-CSRF-Token', secondCsrfToken)
      .send({});
    expect(secondRes.status).toBe(409);
  });

  it('rejects a GET signups from an active member who is not the poster', async () => {
    const posterCookies = await loginAsActiveMember(
      'g-volunteering-poster-4',
      'poster4@example.com',
    );
    const { cookies: posterCsrfCookies, csrfToken: posterCsrfToken } =
      await withCsrf(posterCookies);
    const created = await createOpportunity(
      posterCsrfCookies,
      posterCsrfToken,
      'mentor-qyc-4',
    );

    const outsiderCookies = await loginAsActiveMember(
      'g-volunteering-outsider-4',
      'outsider4@example.com',
    );

    const res = await request(app.getHttpServer())
      .get(`/volunteering/${created.slug}/signups`)
      .set('Cookie', outsiderCookies);

    expect(res.status).toBe(403);
  });
});
