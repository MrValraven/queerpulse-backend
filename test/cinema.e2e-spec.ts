// Set before the app module is compiled so the webhook signature path is
// deterministic in this suite (ConfigService reads process.env at startup).
process.env.MUX_WEBHOOK_SECRET = 'e2e-webhook-secret';

import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { GoogleAuthGuard } from '../src/auth/guards/google-auth.guard';
import {
  CinemaTitle,
  TitleKind,
  TitleStatus,
} from '../src/cinema/entities/cinema-title.entity';
import { WatchProgress } from '../src/cinema/entities/watch-progress.entity';
import { User, UserRole, UserStatus } from '../src/users/entities/user.entity';

// Stub guard: reads the desired Google profile from a header (same pattern
// as auth-invite-gate.e2e-spec.ts) so login works without touching Google.
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

function muxSignature(body: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

describe('Cinema (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(GoogleAuthGuard)
      .useValue(stubGuard)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    ds = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(async () => {
    await ds.getRepository(WatchProgress).delete({});
    await ds.getRepository(CinemaTitle).delete({});
    await ds.getRepository(User).delete({});
  });

  async function loginAsActiveMember(): Promise<string[]> {
    await ds.getRepository(User).save(
      ds.getRepository(User).create({
        googleId: 'g-cinema',
        email: 'cinema@example.com',
        status: UserStatus.Active,
        role: UserRole.Member,
        activatedAt: new Date(),
      }),
    );
    const res = await request(app.getHttpServer())
      .get('/auth/google/callback')
      .set(
        'x-google-profile',
        JSON.stringify({
          googleId: 'g-cinema',
          email: 'cinema@example.com',
          firstName: 'Cine',
          lastName: 'Phile',
          avatarUrl: null,
        }),
      );
    expect(res.status).toBe(302);
    return res.headers['set-cookie'] as unknown as string[];
  }

  it('rejects unauthenticated access to the titles list', async () => {
    const res = await request(app.getHttpServer()).get('/cinema/titles');
    expect(res.status).toBe(401);
  });

  it('blocks playback requests without a CSRF token (guard order intact)', async () => {
    const res = await request(app.getHttpServer()).post(
      '/cinema/titles/6f2a2c4e-1f4b-4c1a-9a01-4f4dbb0b18aa/playback',
    );
    expect(res.status).toBe(403);
    expect((res.body as { message: string }).message).toContain('CSRF');
  });

  it('lets the Mux webhook past CSRF but rejects a bad signature', async () => {
    const res = await request(app.getHttpServer())
      .post('/cinema/webhooks/mux')
      .set('Content-Type', 'application/json')
      .set('mux-signature', 't=1,v1=deadbeef')
      .send({ type: 'video.asset.ready', data: { id: 'as-1' } });
    // 403 from the signature check, NOT the CSRF guard.
    expect(res.status).toBe(403);
    expect((res.body as { message: string }).message).toBe(
      'Invalid webhook signature',
    );
  });

  it('accepts a correctly signed webhook and acks unknown events', async () => {
    const body = JSON.stringify({
      type: 'video.asset.created',
      data: { id: 'as-unknown' },
    });
    const res = await request(app.getHttpServer())
      .post('/cinema/webhooks/mux')
      .set('Content-Type', 'application/json')
      .set('mux-signature', muxSignature(body, 'e2e-webhook-secret'))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it('lists only published ready titles for an active member', async () => {
    const cookies = await loginAsActiveMember();
    const titles = ds.getRepository(CinemaTitle);
    await titles.save(
      titles.create({
        kind: TitleKind.Film,
        title: 'Published Film',
        status: TitleStatus.Ready,
        muxPlaybackId: 'pb-1',
        durationSeconds: 7200,
        publishedAt: new Date(),
      }),
    );
    await titles.save(
      titles.create({
        kind: TitleKind.Short,
        title: 'Unfinished Draft',
        status: TitleStatus.Draft,
      }),
    );

    const res = await request(app.getHttpServer())
      .get('/cinema/titles')
      .set('Cookie', cookies);
    expect(res.status).toBe(200);
    const items = res.body as { title: string; myProgress: unknown }[];
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Published Film');
    expect(items[0].myProgress).toBeNull();
  });
});
