import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { GoogleAuthGuard } from '../src/auth/guards/google-auth.guard';
import { encodeOAuthState } from '../src/auth/oauth-state';
import {
  AccessTier,
  Community,
  CommunityType,
} from '../src/communities/entities/community.entity';
import { CommunityJoinRequest } from '../src/communities/entities/community-join-request.entity';
import { CommunityMember } from '../src/communities/entities/community-member.entity';
import { CommunityPost } from '../src/communities/entities/community-post.entity';
import { CommunityPostReaction } from '../src/communities/entities/community-post-reaction.entity';
import { CommunityPostReply } from '../src/communities/entities/community-post-reply.entity';
import { User, UserRole, UserStatus } from '../src/users/entities/user.entity';

// Stub guard: read the desired Google profile from a header (same pattern as
// cinema.e2e-spec.ts / auth-invite-gate.e2e-spec.ts) so login works without a
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

describe('Communities (e2e)', () => {
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

  // FK-safe order: reaction/reply/join-request/post children before the
  // roster + community parents, and users last (mirrors cinema.e2e-spec.ts /
  // auth-invite-gate.e2e-spec.ts's teardown discipline; guarded by
  // test/db-safety.ts against ever running outside a *_test database).
  afterEach(async () => {
    await ds.getRepository(CommunityPostReaction).delete({});
    await ds.getRepository(CommunityPostReply).delete({});
    await ds.getRepository(CommunityJoinRequest).delete({});
    await ds.getRepository(CommunityPost).delete({});
    await ds.getRepository(CommunityMember).delete({});
    await ds.getRepository(Community).delete({});
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

  function createCommunityPayload(handle: string) {
    return {
      name: 'Queer Book Club',
      purpose: 'Read and discuss queer lit together.',
      type: CommunityType.Social,
      whoFor: 'Anyone who loves reading',
      accessTier: AccessTier.Public,
      rosterVisible: true,
      features: ['discussion'],
      rules: ['Be kind'],
      tagline: 'Books + community',
      handle,
    };
  }

  async function createCommunity(
    cookies: string[],
    csrfToken: string,
    handle: string,
  ): Promise<{ slug: string; name: string; accessTier: string }> {
    const res = await request(app.getHttpServer())
      .post('/communities')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .send(createCommunityPayload(handle));
    expect(res.status).toBe(201);
    return res.body as { slug: string; name: string; accessTier: string };
  }

  it('rejects unauthenticated access to the communities list', async () => {
    const res = await request(app.getHttpServer()).get('/communities');
    expect(res.status).toBe(401);
  });

  it('lets an active member create a community (CSRF-guarded POST)', async () => {
    const ownerCookies = await loginAsActiveMember(
      'g-community-owner-1',
      'owner1@example.com',
    );
    const { cookies, csrfToken } = await withCsrf(ownerCookies);

    const res = await request(app.getHttpServer())
      .post('/communities')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .send(createCommunityPayload('queer-book-club-1'));

    expect(res.status).toBe(201);
    const body = res.body as {
      slug: string;
      name: string;
      accessTier: string;
      ref: string;
      myRole: string;
      owner: unknown;
    };
    expect(body.slug).toBe('queer-book-club-1');
    expect(body.name).toBe('Queer Book Club');
    expect(body.accessTier).toBe('public');
    expect(body.myRole).toBe('owner');
    expect(body.ref).toMatch(/^QP-C-\d{4}$/);
  });

  it('shows a created community by slug', async () => {
    const ownerCookies = await loginAsActiveMember(
      'g-community-owner-2',
      'owner2@example.com',
    );
    const { cookies, csrfToken } = await withCsrf(ownerCookies);
    const created = await createCommunity(
      cookies,
      csrfToken,
      'queer-book-club-2',
    );

    const res = await request(app.getHttpServer())
      .get(`/communities/${created.slug}`)
      .set('Cookie', ownerCookies);

    expect(res.status).toBe(200);
    const body = res.body as { slug: string; name: string };
    expect(body.slug).toBe(created.slug);
    expect(body.name).toBe('Queer Book Club');
  });

  it('rejects a PATCH from an active member who is not owner/mod', async () => {
    const ownerCookies = await loginAsActiveMember(
      'g-community-owner-3',
      'owner3@example.com',
    );
    const { cookies: ownerCsrfCookies, csrfToken: ownerCsrfToken } =
      await withCsrf(ownerCookies);
    const created = await createCommunity(
      ownerCsrfCookies,
      ownerCsrfToken,
      'queer-book-club-3',
    );

    const outsiderCookies = await loginAsActiveMember(
      'g-community-outsider-3',
      'outsider3@example.com',
    );
    const { cookies: outsiderCsrfCookies, csrfToken: outsiderCsrfToken } =
      await withCsrf(outsiderCookies);

    const res = await request(app.getHttpServer())
      .patch(`/communities/${created.slug}`)
      .set('Cookie', outsiderCsrfCookies)
      .set('X-CSRF-Token', outsiderCsrfToken)
      .send({ tagline: 'Hijacked tagline' });

    expect(res.status).toBe(403);
  });

  it('lets any active member instantly join a public community', async () => {
    const ownerCookies = await loginAsActiveMember(
      'g-community-owner-4',
      'owner4@example.com',
    );
    const { cookies: ownerCsrfCookies, csrfToken: ownerCsrfToken } =
      await withCsrf(ownerCookies);
    const created = await createCommunity(
      ownerCsrfCookies,
      ownerCsrfToken,
      'queer-book-club-4',
    );

    const joinerCookies = await loginAsActiveMember(
      'g-community-joiner-4',
      'joiner4@example.com',
    );
    const { cookies: joinerCsrfCookies, csrfToken: joinerCsrfToken } =
      await withCsrf(joinerCookies);

    const res = await request(app.getHttpServer())
      .post(`/communities/${created.slug}/join`)
      .set('Cookie', joinerCsrfCookies)
      .set('X-CSRF-Token', joinerCsrfToken)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'joined' });
  });
});
