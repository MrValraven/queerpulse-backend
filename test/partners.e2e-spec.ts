import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { GoogleAuthGuard } from '../src/auth/guards/google-auth.guard';
import { encodeOAuthState } from '../src/auth/oauth-state';
import {
  Partner,
  PartnerRegion,
  PartnerStatus,
} from '../src/partners/entities/partner.entity';
import { User, UserRole, UserStatus } from '../src/users/entities/user.entity';

// Stub guard: read the desired Google profile from a header (same pattern as
// companies.e2e-spec.ts / volunteering.e2e-spec.ts) so login works without a
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

describe('Partners (e2e)', () => {
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

  // FK-safe order: `partners.submitted_by_id` is `ON DELETE CASCADE` into
  // `users`, and `volunteer_opportunities.partner_id` is `ON DELETE SET NULL`
  // out of `partners` — this suite never seeds any volunteer_opportunities
  // rows itself, so there's nothing to null out first; deleting partners
  // then users (mirrors companies.e2e-spec.ts's "child before parent, users
  // last" discipline) is FK-safe on its own. Guarded by test/db-safety.ts
  // against ever running outside a *_test database.
  afterEach(async () => {
    await ds.getRepository(Partner).delete({});
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

  // Role is baked into the JWT at login time (`AuthService.issueTokensWithRow`
  // signs `role: user.role` off the DB row as it stood at login) — so the
  // desired role has to be seeded BEFORE the oauth callback mints the tokens,
  // not patched onto the User row afterwards.
  async function loginAsActiveMember(
    googleId: string,
    email: string,
  ): Promise<string[]> {
    await seedMember(googleId, email, UserRole.Member);
    return login(googleId, email);
  }

  async function loginAsAdmin(
    googleId: string,
    email: string,
  ): Promise<string[]> {
    await seedMember(googleId, email, UserRole.Admin);
    return login(googleId, email);
  }

  async function userIdFor(googleId: string): Promise<string> {
    const user = await ds.getRepository(User).findOne({ where: { googleId } });
    if (!user) {
      throw new Error(`no seeded user for googleId "${googleId}"`);
    }
    return user.id;
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

  function partnerFixture(overrides: {
    slug: string;
    status: PartnerStatus;
    submittedById: string;
  }): Partial<Partner> {
    return {
      name: 'Fixture Partner',
      logo: 'FP',
      region: PartnerRegion.Pt,
      regionLabel: 'Portugal',
      city: 'Lisbon',
      desc: 'A fixture partner used for e2e assertions.',
      tags: [],
      tier: 'Community',
      since: '2020',
      eyebrow: 'Partner',
      tagline: 'A tagline.',
      about: [],
      stats: [],
      aboutMore: [],
      jointWork: [],
      timeline: [],
      how: [],
      funding: '',
      atGlance: [],
      contact: {
        phone: null,
        phoneNote: null,
        email: null,
        website: null,
        address: null,
      },
      reviewNote: null,
      ...overrides,
    };
  }

  function createPartnerApplicationPayload(handle: string) {
    return {
      name: 'Coalizão Arco-Íris',
      logo: 'CA',
      region: 'pt',
      regionLabel: 'Portugal',
      city: 'Lisbon',
      desc: 'A grassroots coalition supporting LGBTI+ rights across Portugal.',
      tier: 'Community',
      since: '2019',
      eyebrow: 'Advocacy partner',
      tagline: 'Rights, together.',
      handle,
    };
  }

  it('rejects unauthenticated access to the partners list', async () => {
    const res = await request(app.getHttpServer()).get('/partners');
    expect(res.status).toBe(401);
  });

  it('shows only approved partners publicly, hiding pending ones', async () => {
    const viewerCookies = await loginAsActiveMember(
      'g-partner-viewer-1',
      'viewer1@example.com',
    );
    const submitterId = await userIdFor('g-partner-viewer-1');
    const partners = ds.getRepository(Partner);

    await partners.save(
      partners.create(
        partnerFixture({
          slug: 'approved-partner-1',
          status: PartnerStatus.Approved,
          submittedById: submitterId,
        }),
      ),
    );
    await partners.save(
      partners.create(
        partnerFixture({
          slug: 'pending-partner-1',
          status: PartnerStatus.Pending,
          submittedById: submitterId,
        }),
      ),
    );

    const res = await request(app.getHttpServer())
      .get('/partners')
      .set('Cookie', viewerCookies);

    expect(res.status).toBe(200);
    const body = res.body as { items: { slug: string }[]; total: number };
    expect(body.items.map((p) => p.slug)).toEqual(['approved-partner-1']);
    expect(body.total).toBe(1);
  });

  it('404s a pending partner by slug (hides its existence from the public)', async () => {
    const viewerCookies = await loginAsActiveMember(
      'g-partner-viewer-2',
      'viewer2@example.com',
    );
    const submitterId = await userIdFor('g-partner-viewer-2');
    const partners = ds.getRepository(Partner);
    await partners.save(
      partners.create(
        partnerFixture({
          slug: 'pending-partner-2',
          status: PartnerStatus.Pending,
          submittedById: submitterId,
        }),
      ),
    );

    const res = await request(app.getHttpServer())
      .get('/partners/pending-partner-2')
      .set('Cookie', viewerCookies);

    expect(res.status).toBe(404);
  });

  it('lets an active member submit a partner application (CSRF-guarded POST) as pending', async () => {
    const memberCookies = await loginAsActiveMember(
      'g-partner-submitter-1',
      'submitter1@example.com',
    );
    const { cookies, csrfToken } = await withCsrf(memberCookies);

    const res = await request(app.getHttpServer())
      .post('/partner-applications')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .send(createPartnerApplicationPayload('coalizao-arco-iris'));

    expect(res.status).toBe(201);
    const body = res.body as {
      slug: string;
      status: string;
      submittedBy: { slug: string } | null;
    };
    expect(body.slug).toBe('coalizao-arco-iris');
    expect(body.status).toBe('pending');
    expect(body.submittedBy).toBeTruthy();
  });

  it('rejects a non-admin from listing partner applications', async () => {
    const memberCookies = await loginAsActiveMember(
      'g-partner-nonadmin-1',
      'nonadmin1@example.com',
    );

    const res = await request(app.getHttpServer())
      .get('/partner-applications')
      .set('Cookie', memberCookies);

    expect(res.status).toBe(403);
  });

  it('lets an admin approve a pending application, publishing it to the public directory', async () => {
    const memberCookies = await loginAsActiveMember(
      'g-partner-submitter-2',
      'submitter2@example.com',
    );
    const { cookies: memberCsrfCookies, csrfToken: memberCsrfToken } =
      await withCsrf(memberCookies);
    const submitRes = await request(app.getHttpServer())
      .post('/partner-applications')
      .set('Cookie', memberCsrfCookies)
      .set('X-CSRF-Token', memberCsrfToken)
      .send(createPartnerApplicationPayload('coalizao-arco-iris-2'));
    expect(submitRes.status).toBe(201);
    const { id, slug } = submitRes.body as { id: string; slug: string };

    const adminCookies = await loginAsAdmin(
      'g-partner-admin-1',
      'admin1@example.com',
    );
    const { cookies: adminCsrfCookies, csrfToken: adminCsrfToken } =
      await withCsrf(adminCookies);

    const patchRes = await request(app.getHttpServer())
      .patch(`/partner-applications/${id}`)
      .set('Cookie', adminCsrfCookies)
      .set('X-CSRF-Token', adminCsrfToken)
      .send({ action: 'approve' });

    expect(patchRes.status).toBe(200);
    expect((patchRes.body as { status: string }).status).toBe('approved');

    const publicRes = await request(app.getHttpServer())
      .get(`/partners/${slug}`)
      .set('Cookie', memberCookies);
    expect(publicRes.status).toBe(200);
    expect((publicRes.body as { slug: string }).slug).toBe(slug);
  });

  it('lets an admin reject a pending application, recording a reviewNote', async () => {
    const memberCookies = await loginAsActiveMember(
      'g-partner-submitter-3',
      'submitter3@example.com',
    );
    const { cookies: memberCsrfCookies, csrfToken: memberCsrfToken } =
      await withCsrf(memberCookies);
    const submitRes = await request(app.getHttpServer())
      .post('/partner-applications')
      .set('Cookie', memberCsrfCookies)
      .set('X-CSRF-Token', memberCsrfToken)
      .send(createPartnerApplicationPayload('coalizao-arco-iris-3'));
    expect(submitRes.status).toBe(201);
    const { id } = submitRes.body as { id: string };

    const adminCookies = await loginAsAdmin(
      'g-partner-admin-2',
      'admin2@example.com',
    );
    const { cookies: adminCsrfCookies, csrfToken: adminCsrfToken } =
      await withCsrf(adminCookies);

    const patchRes = await request(app.getHttpServer())
      .patch(`/partner-applications/${id}`)
      .set('Cookie', adminCsrfCookies)
      .set('X-CSRF-Token', adminCsrfToken)
      .send({ action: 'reject', note: 'Not a fit for the directory' });

    expect(patchRes.status).toBe(200);
    const body = patchRes.body as { status: string; reviewNote: string };
    expect(body.status).toBe('rejected');
    expect(body.reviewNote).toBe('Not a fit for the directory');
  });
});
