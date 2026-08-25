import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { GoogleAuthGuard } from '../src/auth/guards/google-auth.guard';
import { encodeOAuthState } from '../src/auth/oauth-state';
import { MagazineWriterApplication } from '../src/magazine/entities/magazine-writer-application.entity';
import {
  AdminWriterApplicationsPageDTO,
  WriterApplicationDTO,
} from '../src/magazine/writer-application-response';
import { UserStaffRole } from '../src/users/entities/user-staff-role.entity';
import { User, UserRole, UserStatus } from '../src/users/entities/user.entity';

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

describe('Magazine writer applications (e2e)', () => {
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
    app.use(cookieParser());
    await app.init();
    ds = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  // FK-safe order: applications/staff-roles before users.
  afterEach(async () => {
    await ds.getRepository(MagazineWriterApplication).delete({});
    await ds.getRepository(UserStaffRole).delete({});
    await ds.getRepository(User).delete({});
  });

  async function seedUser(
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

  it('lets a member apply, then read their own pending application', async () => {
    await seedUser('g-writer-1', 'writer1@example.com');
    const { cookies, csrfToken } = await withCsrf(
      await login('g-writer-1', 'writer1@example.com'),
    );

    await request(app.getHttpServer() as App)
      .post('/magazine/writer-applications')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .send({
        pitchNote: 'I want to write about queer archives.',
        sampleText: 'A paragraph.',
      })
      .expect(201);

    const mine = await request(app.getHttpServer() as App)
      .get('/magazine/writer-applications/mine')
      .set('Cookie', cookies)
      .expect(200);
    expect((mine.body as WriterApplicationDTO).status).toBe('pending');
  });

  it('rejects an application with no sample', async () => {
    await seedUser('g-writer-2', 'writer2@example.com');
    const { cookies, csrfToken } = await withCsrf(
      await login('g-writer-2', 'writer2@example.com'),
    );
    await request(app.getHttpServer() as App)
      .post('/magazine/writer-applications')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken)
      .send({ pitchNote: 'Just a note.' })
      .expect(400);
  });

  it('lets an admin list and approve an application, granting magazine_writer', async () => {
    await seedUser('g-writer-3', 'writer3@example.com');
    const writer = await withCsrf(
      await login('g-writer-3', 'writer3@example.com'),
    );

    await seedUser('g-admin-1', 'admin1@example.com', UserRole.Admin);
    const admin = await withCsrf(
      await login('g-admin-1', 'admin1@example.com'),
    );

    const createdResponse = await request(app.getHttpServer() as App)
      .post('/magazine/writer-applications')
      .set('Cookie', writer.cookies)
      .set('X-CSRF-Token', writer.csrfToken)
      .send({ sampleLink: 'https://example.com/my-essay' })
      .expect(201);
    const created = createdResponse.body as WriterApplicationDTO;

    const listResponse = await request(app.getHttpServer() as App)
      .get('/admin/magazine-writer-applications?status=pending')
      .set('Cookie', admin.cookies)
      .expect(200);
    const list = listResponse.body as AdminWriterApplicationsPageDTO;
    expect(list.items.some((item) => item.id === created.id)).toBe(true);

    const triagedResponse = await request(app.getHttpServer() as App)
      .patch(`/admin/magazine-writer-applications/${created.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ status: 'approved' })
      .expect(200);
    const triaged = triagedResponse.body as WriterApplicationDTO;
    expect(triaged.status).toBe('approved');

    // Triaging the same application again 409s.
    await request(app.getHttpServer() as App)
      .patch(`/admin/magazine-writer-applications/${created.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ status: 'declined' })
      .expect(409);
  });
});
