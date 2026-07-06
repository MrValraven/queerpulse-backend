import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { GoogleAuthGuard } from '../src/auth/guards/google-auth.guard';
import { encodeOAuthState } from '../src/auth/oauth-state';
import { CompanyReview } from '../src/companies/entities/company-review.entity';
import { CompanyTeamMember } from '../src/companies/entities/company-team-member.entity';
import { Company } from '../src/companies/entities/company.entity';
import { User, UserRole, UserStatus } from '../src/users/entities/user.entity';

// Stub guard: read the desired Google profile from a header (same pattern as
// communities.e2e-spec.ts / cinema.e2e-spec.ts) so login works without a
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

describe('Companies (e2e)', () => {
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

  // FK-safe order: reviews/team rows before the company parent, users last
  // (mirrors communities.e2e-spec.ts's teardown discipline; guarded by
  // test/db-safety.ts against ever running outside a *_test database).
  afterEach(async () => {
    await ds.getRepository(CompanyReview).delete({});
    await ds.getRepository(CompanyTeamMember).delete({});
    await ds.getRepository(Company).delete({});
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

  function createCompanyPayload(handle: string) {
    return {
      nameText: 'Atelier Pulso',
      tagline: 'A queer-run design studio.',
      about: 'We design things for the community.',
      queerRun: true,
      queerLed: true,
      handle,
    };
  }

  async function createCompany(
    cookies: string[],
    csrfToken: string,
    handle: string,
  ): Promise<{ slug: string; nameText: string }> {
    const res = await request(app.getHttpServer())
      .post('/companies')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .send(createCompanyPayload(handle));
    expect(res.status).toBe(201);
    return res.body as { slug: string; nameText: string };
  }

  it('rejects unauthenticated access to the companies list', async () => {
    const res = await request(app.getHttpServer()).get('/companies');
    expect(res.status).toBe(401);
  });

  it('lets an active member create a company (CSRF-guarded POST), forcing verified=false', async () => {
    const ownerCookies = await loginAsActiveMember(
      'g-company-owner-1',
      'owner1@example.com',
    );
    const { cookies, csrfToken } = await withCsrf(ownerCookies);

    const res = await request(app.getHttpServer())
      .post('/companies')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .send(createCompanyPayload('atelier-pulso-1'));

    expect(res.status).toBe(201);
    const body = res.body as {
      slug: string;
      nameText: string;
      badges: { queerRun: boolean; queerLed: boolean; verified: boolean };
      isOwner: boolean;
    };
    expect(body.slug).toBe('atelier-pulso-1');
    expect(body.nameText).toBe('Atelier Pulso');
    expect(body.badges).toEqual({
      queerRun: true,
      queerLed: true,
      verified: false,
    });
    expect(body.isOwner).toBe(true);
  });

  it('shows a created company by slug', async () => {
    const ownerCookies = await loginAsActiveMember(
      'g-company-owner-2',
      'owner2@example.com',
    );
    const { cookies, csrfToken } = await withCsrf(ownerCookies);
    const created = await createCompany(cookies, csrfToken, 'atelier-pulso-2');

    const res = await request(app.getHttpServer())
      .get(`/companies/${created.slug}`)
      .set('Cookie', ownerCookies);

    expect(res.status).toBe(200);
    const body = res.body as { slug: string; nameText: string };
    expect(body.slug).toBe(created.slug);
    expect(body.nameText).toBe('Atelier Pulso');
  });

  it('rejects a PATCH from an active member who is not the owner', async () => {
    const ownerCookies = await loginAsActiveMember(
      'g-company-owner-3',
      'owner3@example.com',
    );
    const { cookies: ownerCsrfCookies, csrfToken: ownerCsrfToken } =
      await withCsrf(ownerCookies);
    const created = await createCompany(
      ownerCsrfCookies,
      ownerCsrfToken,
      'atelier-pulso-3',
    );

    const outsiderCookies = await loginAsActiveMember(
      'g-company-outsider-3',
      'outsider3@example.com',
    );
    const { cookies: outsiderCsrfCookies, csrfToken: outsiderCsrfToken } =
      await withCsrf(outsiderCookies);

    const res = await request(app.getHttpServer())
      .patch(`/companies/${created.slug}`)
      .set('Cookie', outsiderCsrfCookies)
      .set('X-CSRF-Token', outsiderCsrfToken)
      .send({ tagline: 'Hijacked tagline' });

    expect(res.status).toBe(403);
  });

  it('lets an active member post a review for a company', async () => {
    const ownerCookies = await loginAsActiveMember(
      'g-company-owner-4',
      'owner4@example.com',
    );
    const { cookies: ownerCsrfCookies, csrfToken: ownerCsrfToken } =
      await withCsrf(ownerCookies);
    const created = await createCompany(
      ownerCsrfCookies,
      ownerCsrfToken,
      'atelier-pulso-4',
    );

    const reviewerCookies = await loginAsActiveMember(
      'g-company-reviewer-4',
      'reviewer4@example.com',
    );
    const { cookies: reviewerCsrfCookies, csrfToken: reviewerCsrfToken } =
      await withCsrf(reviewerCookies);

    const res = await request(app.getHttpServer())
      .post(`/companies/${created.slug}/reviews`)
      .set('Cookie', reviewerCsrfCookies)
      .set('X-CSRF-Token', reviewerCsrfToken)
      .send({
        title: 'Great place to work',
        stars: 5,
        byline: 'Former team member',
        body: ['Loved the culture.'],
      });

    expect(res.status).toBe(201);
    const body = res.body as { stars: number; author: { slug: string } };
    expect(body.stars).toBe(5);
    expect(body.author).toBeTruthy();
  });
});
