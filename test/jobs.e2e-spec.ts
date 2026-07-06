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
import { JobApplication } from '../src/jobs/entities/job-application.entity';
import { Job } from '../src/jobs/entities/job.entity';
import { User, UserRole, UserStatus } from '../src/users/entities/user.entity';

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

describe('Jobs (e2e)', () => {
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

  // FK-safe order: job_applications/jobs before companies (which they FK
  // into), company reviews/team rows before the company parent, users last
  // (mirrors companies.e2e-spec.ts's teardown discipline; guarded by
  // test/db-safety.ts against ever running outside a *_test database).
  afterEach(async () => {
    await ds.getRepository(JobApplication).delete({});
    await ds.getRepository(Job).delete({});
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

  function createJobPayload(companySlug: string) {
    return {
      title: 'Backend Engineer',
      category: 'Engineering',
      commitment: 'Full-time',
      seniority: 'Mid',
      format: 'remote',
      location: 'Remote',
      description: 'Build the platform with us.',
      companySlug,
      agreement: true,
    };
  }

  async function createJob(
    cookies: string[],
    csrfToken: string,
    companySlug: string,
  ): Promise<{ slug: string; title: string }> {
    const res = await request(app.getHttpServer())
      .post('/jobs')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .send(createJobPayload(companySlug));
    expect(res.status).toBe(201);
    return res.body as { slug: string; title: string };
  }

  it('rejects unauthenticated access to the jobs list', async () => {
    const res = await request(app.getHttpServer()).get('/jobs');
    expect(res.status).toBe(401);
  });

  it('lets an affiliated poster create a job under an existing company (CSRF-guarded POST)', async () => {
    const ownerCookies = await loginAsActiveMember(
      'g-job-owner-1',
      'jobowner1@example.com',
    );
    const { cookies, csrfToken } = await withCsrf(ownerCookies);
    const company = await createCompany(cookies, csrfToken, 'atelier-pulso-j1');

    const res = await request(app.getHttpServer())
      .post('/jobs')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .send(createJobPayload(company.slug));

    expect(res.status).toBe(201);
    const body = res.body as {
      slug: string;
      title: string;
      company: { slug: string; nameText: string } | null;
      isPoster: boolean;
      status: string;
    };
    expect(body.title).toBe('Backend Engineer');
    expect(body.company).toEqual({
      slug: company.slug,
      nameText: 'Atelier Pulso',
    });
    expect(body.isPoster).toBe(true);
    expect(body.status).toBe('open');
  });

  it('rejects a job POST from a member unaffiliated with the company (403)', async () => {
    const ownerCookies = await loginAsActiveMember(
      'g-job-owner-2',
      'jobowner2@example.com',
    );
    const { cookies: ownerCookiesCsrf, csrfToken: ownerCsrfToken } =
      await withCsrf(ownerCookies);
    const company = await createCompany(
      ownerCookiesCsrf,
      ownerCsrfToken,
      'atelier-pulso-j2',
    );

    const outsiderCookies = await loginAsActiveMember(
      'g-job-outsider-2',
      'joboutsider2@example.com',
    );
    const { cookies: outsiderCsrfCookies, csrfToken: outsiderCsrfToken } =
      await withCsrf(outsiderCookies);

    const res = await request(app.getHttpServer())
      .post('/jobs')
      .set('Cookie', outsiderCsrfCookies)
      .set('X-CSRF-Token', outsiderCsrfToken)
      .send(createJobPayload(company.slug));

    expect(res.status).toBe(403);
  });

  it('shows a created job by slug', async () => {
    const ownerCookies = await loginAsActiveMember(
      'g-job-owner-3',
      'jobowner3@example.com',
    );
    const { cookies, csrfToken } = await withCsrf(ownerCookies);
    const company = await createCompany(cookies, csrfToken, 'atelier-pulso-j3');
    const job = await createJob(cookies, csrfToken, company.slug);

    const res = await request(app.getHttpServer())
      .get(`/jobs/${job.slug}`)
      .set('Cookie', ownerCookies);

    expect(res.status).toBe(200);
    const body = res.body as { slug: string; title: string };
    expect(body.slug).toBe(job.slug);
    expect(body.title).toBe('Backend Engineer');
  });

  it('lets an active member apply to a job (CSRF-guarded POST)', async () => {
    const ownerCookies = await loginAsActiveMember(
      'g-job-owner-4',
      'jobowner4@example.com',
    );
    const { cookies: ownerCsrfCookies, csrfToken: ownerCsrfToken } =
      await withCsrf(ownerCookies);
    const company = await createCompany(
      ownerCsrfCookies,
      ownerCsrfToken,
      'atelier-pulso-j4',
    );
    const job = await createJob(ownerCsrfCookies, ownerCsrfToken, company.slug);

    const applicantCookies = await loginAsActiveMember(
      'g-job-applicant-4',
      'jobapplicant4@example.com',
    );
    const { cookies: applicantCsrfCookies, csrfToken: applicantCsrfToken } =
      await withCsrf(applicantCookies);

    const res = await request(app.getHttpServer())
      .post(`/jobs/${job.slug}/applications`)
      .set('Cookie', applicantCsrfCookies)
      .set('X-CSRF-Token', applicantCsrfToken)
      .send({
        answers: [{ question: 'Why this role?', answer: 'It fits my skills.' }],
        coverNote: "I'd love to help build this.",
      });

    expect(res.status).toBe(201);
    const body = res.body as {
      status: string;
      applicant: { slug: string } | null;
    };
    expect(body.status).toBe('submitted');
    expect(body.applicant).toBeTruthy();
  });

  it('rejects a non-poster from viewing a job’s applications (403)', async () => {
    const ownerCookies = await loginAsActiveMember(
      'g-job-owner-5',
      'jobowner5@example.com',
    );
    const { cookies: ownerCsrfCookies, csrfToken: ownerCsrfToken } =
      await withCsrf(ownerCookies);
    const company = await createCompany(
      ownerCsrfCookies,
      ownerCsrfToken,
      'atelier-pulso-j5',
    );
    const job = await createJob(ownerCsrfCookies, ownerCsrfToken, company.slug);

    const outsiderCookies = await loginAsActiveMember(
      'g-job-outsider-5',
      'joboutsider5@example.com',
    );

    const res = await request(app.getHttpServer())
      .get(`/jobs/${job.slug}/applications`)
      .set('Cookie', outsiderCookies);

    expect(res.status).toBe(403);
  });
});
