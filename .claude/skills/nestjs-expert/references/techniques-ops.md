# NestJS Techniques: Scheduling, Queues, Events, Files, Cookies, Logging

Target: NestJS v11 + TypeScript. Default HTTP platform is Express (`@nestjs/platform-express`). Package manager for this repo is **pnpm**.

---

## Task Scheduling (`@nestjs/schedule`)

Cron-like scheduling inside the Nest process (wraps the `cron` package + native `setInterval`/`setTimeout`). Jobs run on a single instance — for multi-instance deployments, guard with a distributed lock or run schedulers on a dedicated worker.

```bash
pnpm add @nestjs/schedule
```

Initialize once in the root module. This bootstraps every declarative job found in providers:

```typescript
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [ScheduleModule.forRoot()],
})
export class AppModule {}
```

Declarative jobs must live inside an `@Injectable()` provider (Nest scans provider methods for the decorators).

### `@Cron()`

Pattern format: `second minute hour day-of-month month day-of-week` (6 fields; seconds optional — 5 fields is also accepted).

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  @Cron('45 * * * * *') // at 45s of every minute
  handleCron() {
    this.logger.debug('Called every minute on the 45th second');
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  handleInterval() {}

  // One-off run at a specific Date
  @Cron(new Date(Date.now() + 10 * 1000))
  runOnce() {}
}
```

`@Cron(pattern, options)` second arg:

```typescript
@Cron('* * 0 * * *', {
  name: 'notifications',          // required to control it later via SchedulerRegistry
  timeZone: 'Europe/Lisbon',      // mutually exclusive with utcOffset
  utcOffset: '+01:00',            // or number of minutes/hours; cannot combine with timeZone
  disabled: false,                // register but do not start
  waitForCompletion: true,        // v11: block overlapping runs until current finishes
})
handleReminders() {}
```

### `CronExpression` enum (common values)

`EVERY_SECOND`, `EVERY_5_SECONDS`, `EVERY_10_SECONDS`, `EVERY_30_SECONDS`, `EVERY_MINUTE`, `EVERY_5_MINUTES`, `EVERY_10_MINUTES`, `EVERY_30_MINUTES`, `EVERY_HOUR`, `EVERY_DAY_AT_MIDNIGHT`, `EVERY_DAY_AT_NOON`, `EVERY_DAY_AT_1AM`...`EVERY_DAY_AT_11PM`, `EVERY_WEEK`, `EVERY_WEEKDAY`, `EVERY_WEEKEND`, `EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT`, `EVERY_QUARTER`, `EVERY_YEAR`, `MONDAY_TO_FRIDAY_AT_09_00AM`, etc.

### `@Interval()` and `@Timeout()`

```typescript
@Interval(10000)                 // every 10s, anonymous
handleInterval() {}

@Interval('notifications', 2500) // named -> controllable via registry
handleNamed() {}

@Timeout(5000)                   // once, 5s after startup
handleTimeout() {}

@Timeout('cleanup', 5000)
handleNamedTimeout() {}
```

### Dynamic scheduling — `SchedulerRegistry`

Inject the registry to add/inspect/remove jobs at runtime. For dynamic cron jobs you construct a `CronJob` from the `cron` package.

```typescript
import { Injectable } from '@nestjs/common';
import { Cron, SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

@Injectable()
export class ReminderService {
  constructor(private readonly registry: SchedulerRegistry) {}

  scheduleEventReminder(eventId: string, when: Date) {
    const job = new CronJob(when, () => {
      // fire reminder notification for eventId
    });
    this.registry.addCronJob(`reminder-${eventId}`, job);
    job.start(); // jobs added dynamically are NOT auto-started
  }

  cancel(eventId: string) {
    this.registry.deleteCronJob(`reminder-${eventId}`);
  }

  // Inspect a declarative @Cron('...', { name: 'notifications' })
  controlExisting() {
    const job = this.registry.getCronJob('notifications');
    job.stop();
    job.start();
    console.log(job.lastDate(), job.nextDate());
  }

  listAll() {
    const jobs = this.registry.getCronJobs();   // Map<string, CronJob>
    jobs.forEach((value, key) => console.log(key, value.nextDate().toJSDate()));
  }
}
```

Full registry API:
- Cron: `addCronJob(name, job)`, `getCronJob(name)`, `getCronJobs(): Map`, `deleteCronJob(name)`, `doesExist('cron', name)`.
- Interval: `addInterval(name, intervalId)`, `getInterval(name)`, `getIntervals(): string[]`, `deleteInterval(name)`.
- Timeout: `addTimeout(name, timeoutId)`, `getTimeout(name)`, `getTimeouts(): string[]`, `deleteTimeout(name)`.

```typescript
const id = setInterval(() => {}, 1000);
this.registry.addInterval('poll', id);
this.registry.deleteInterval('poll'); // clears it internally
```

---

## Queues (`@nestjs/bullmq`)

BullMQ is the actively maintained, modern, TS-native integration (use `@nestjs/bull` only for legacy Bull). Requires **Redis**. Use for: image processing (S3 work images), email/notification fan-out, offloading CPU-heavy work off the request path.

```bash
pnpm add @nestjs/bullmq bullmq
```

### Module registration

```typescript
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

@Module({
  imports: [
    BullModule.forRoot({
      connection: { host: 'localhost', port: 6379 },
    }),
    BullModule.registerQueue({
      name: 'media',                 // queue name -> @InjectQueue('media')
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 1000,      // keep last N or true to remove all
        removeOnFail: 5000,
      },
    }),
  ],
})
export class MediaModule {}
```

Async config (pull Redis URL from `ConfigService`):

```typescript
BullModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    connection: { url: config.getOrThrow('REDIS_URL') },
  }),
});
```

### Producer — inject `Queue` and add jobs

```typescript
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class MediaService {
  constructor(@InjectQueue('media') private readonly mediaQueue: Queue) {}

  async enqueueResize(key: string) {
    await this.mediaQueue.add(
      'resize',                      // job NAME (matched in processor)
      { key },                       // job DATA payload
      {
        delay: 5000,                 // ms before processing
        priority: 1,                 // lower number = higher priority
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        jobId: `resize:${key}`,      // dedupe key
        lifo: false,
      },
    );
  }

  // Bulk add
  async enqueueMany(keys: string[]) {
    await this.mediaQueue.addBulk(
      keys.map((key) => ({ name: 'resize', data: { key } })),
    );
  }

  // Repeatable job (cron-like, persisted in Redis)
  async scheduleDigest() {
    await this.mediaQueue.add('digest', {}, { repeat: { pattern: '0 9 * * *' } });
  }
}
```

### Consumer — `@Processor` + `WorkerHost`

BullMQ uses a single `process()` method; dispatch by `job.name` (no `@Process('name')` decorator like legacy Bull).

```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('media', { concurrency: 5 })
export class MediaProcessor extends WorkerHost {
  async process(job: Job<{ key: string }, void, string>): Promise<void> {
    switch (job.name) {
      case 'resize':
        await job.updateProgress(50);
        // ... do work
        await job.updateProgress(100);
        break;
      case 'digest':
        break;
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {}

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {}

  @OnWorkerEvent('active')
  onActive(job: Job) {}
}
```

Register the processor as a provider in the module's `providers: [MediaProcessor]`.

### Queue-level events — `@QueueEventsListener`

```typescript
import { QueueEventsListener, QueueEventsHost, OnQueueEvent } from '@nestjs/bullmq';

@QueueEventsListener('media')
export class MediaQueueEvents extends QueueEventsHost {
  @OnQueueEvent('completed')
  onCompleted({ jobId }: { jobId: string }) {}
}
```

### Management

```typescript
await this.mediaQueue.pause();
await this.mediaQueue.resume();
await this.mediaQueue.getJobCounts(); // { waiting, active, completed, failed, delayed }
```

CPU-bound work can run in a forked sandboxed process by pointing the processor at a separate file (BullMQ `Worker` with a processor file path).

---

## Events (`@nestjs/event-emitter`)

In-process observer pattern (EventEmitter2). Use for decoupled side effects: emit a domain event (e.g. `user.followed`, `work.published`) and let notification listeners react without coupling the producer to consumers. Synchronous by default; not durable (use queues for guaranteed/retryable delivery).

```bash
pnpm add @nestjs/event-emitter
```

```typescript
import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

@Module({
  imports: [
    EventEmitterModule.forRoot({
      wildcard: true,           // enable '*' / '**' patterns
      delimiter: '.',           // namespace separator
      maxListeners: 10,
      verboseMemoryLeak: true,  // log warning when maxListeners exceeded
      ignoreErrors: false,      // throw on 'error' events instead of swallowing
      newListener: false,
      removeListener: false,
    }),
  ],
})
export class AppModule {}
```

### Emitting

```typescript
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

export class UserFollowedEvent {
  constructor(public readonly followerId: string, public readonly targetId: string) {}
}

@Injectable()
export class FollowService {
  constructor(private readonly eventEmitter: EventEmitter2) {}

  follow(followerId: string, targetId: string) {
    // ...persist...
    this.eventEmitter.emit('user.followed', new UserFollowedEvent(followerId, targetId));
  }

  // emitAsync awaits all (async) listeners and returns their results
  async followAwait(e: UserFollowedEvent) {
    const results = await this.eventEmitter.emitAsync('user.followed', e);
  }
}
```

### Listening — `@OnEvent`

Listeners must be in providers. They cannot be request-scoped.

```typescript
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

@Injectable()
export class NotificationListener {
  @OnEvent('user.followed')
  handleFollow(event: UserFollowedEvent) {
    // create + send notification
  }

  // Options
  @OnEvent('user.followed', {
    async: true,            // listener returns a Promise; awaited by emitAsync
    promisify: true,
    suppressErrors: true,   // default true: errors in listener don't propagate
    prependListener: false,
  })
  audit(event: UserFollowedEvent) {}

  // Wildcards (require wildcard:true)
  @OnEvent('user.*')
  anyUserEvent(payload: unknown) {}

  @OnEvent('**')
  allEvents(payload: unknown) {}
}
```

### Avoiding lost events at startup

If you emit during `onModuleInit`/early lifecycle, listeners may not be registered yet. Gate with the readiness watcher:

```typescript
import { EventEmitterReadinessWatcher } from '@nestjs/event-emitter';

constructor(
  private readonly emitter: EventEmitter2,
  private readonly watcher: EventEmitterReadinessWatcher,
) {}

async onApplicationBootstrap() {
  await this.watcher.waitUntilReady();
  this.emitter.emit('app.ready', {});
}
```

---

## Logger (`@nestjs/common`)

Built-in `Logger` / `ConsoleLogger`. Log levels: `'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose'`.

### Using the logger in a service

```typescript
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name); // context label

  signIn(email: string) {
    this.logger.log(`Sign-in attempt: ${email}`);
    this.logger.warn('Suspicious');
    this.logger.error('Failed', stackTraceString);
    this.logger.debug({ email });
    this.logger.verbose('trace');
  }
}
```

### Configuring at bootstrap

```typescript
// Disable entirely
const app = await NestFactory.create(AppModule, { logger: false });

// Restrict levels
const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'fatal'] });

// JSON structured output (great for ECS/CloudWatch); auto-disables colors
import { ConsoleLogger } from '@nestjs/common';
const app = await NestFactory.create(AppModule, {
  logger: new ConsoleLogger({
    json: true,
    prefix: 'QueerPulse',
    timestamp: true,
    logLevels: ['log', 'error', 'warn'],
    colors: false,
  }),
});
```

`ConsoleLogger` options include: `logLevels`, `timestamp` (show ms delta between messages), `prefix` (default `Nest`), `json`, `colors`, `context`, `compact`, `maxArrayLength`, `maxStringLength`, `depth`, `sorted`, `showHidden`, `breakLength`.

### Custom logger via DI (with `bufferLogs`)

```typescript
import { LoggerService, LogLevel } from '@nestjs/common';

export class MyLogger implements LoggerService {
  log(message: any, ...optional: any[]) {}
  error(message: any, ...optional: any[]) {}
  warn(message: any, ...optional: any[]) {}
  debug?(message: any, ...optional: any[]) {}
  verbose?(message: any, ...optional: any[]) {}
  fatal?(message: any, ...optional: any[]) {}
}

// Buffer startup logs, then attach the DI-resolved logger
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(app.get(MyLogger));
```

Extend the built-in instead of reimplementing:

```typescript
import { ConsoleLogger } from '@nestjs/common';

export class JsonLogger extends ConsoleLogger {
  error(message: any, stack?: string, context?: string) {
    super.error(message, stack, context);
  }
}
```

For production filtering/centralization, integrate `nestjs-pino` or `nest-winston`.

---

## File Upload (`multer`, Express)

`multipart/form-data` handling via built-in multer interceptors. For type safety install types (multer ships with `@nestjs/platform-express`):

```bash
pnpm add -D @types/multer   # provides Express.Multer.File
```

### Single file

```typescript
import { Controller, Post, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

@Controller('avatar')
export class AvatarController {
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  upload(@UploadedFile() file: Express.Multer.File) {
    // file.buffer, file.originalname, file.mimetype, file.size
  }
}
```

### Validation — `ParseFilePipe` + validators

```typescript
import { ParseFilePipe, MaxFileSizeValidator, FileTypeValidator } from '@nestjs/common';

@Post('avatar')
@UseInterceptors(FileInterceptor('file'))
uploadAvatar(
  @UploadedFile(
    new ParseFilePipe({
      validators: [
        new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }), // 5 MB
        new FileTypeValidator({ fileType: /(jpeg|jpg|png|webp)$/ }),
      ],
      fileIsRequired: true,
      // errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    }),
  )
  file: Express.Multer.File,
) {}
```

Builder form: `ParseFilePipeBuilder`:

```typescript
import { ParseFilePipeBuilder, HttpStatus } from '@nestjs/common';

@UploadedFile(
  new ParseFilePipeBuilder()
    .addFileTypeValidator({ fileType: 'image/png' })
    .addMaxSizeValidator({ maxSize: 5_000_000 })
    .build({ errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY }),
)
```

### Multiple files

```typescript
import { FilesInterceptor, FileFieldsInterceptor, AnyFilesInterceptor, NoFilesInterceptor } from '@nestjs/platform-express';
import { UploadedFiles } from '@nestjs/common';

// Array under one field (max 10)
@Post('gallery')
@UseInterceptors(FilesInterceptor('images', 10))
uploadMany(@UploadedFiles() files: Express.Multer.File[]) {}

// Multiple named fields
@Post('work')
@UseInterceptors(FileFieldsInterceptor([
  { name: 'cover', maxCount: 1 },
  { name: 'images', maxCount: 8 },
]))
uploadWork(@UploadedFiles() files: { cover?: Express.Multer.File[]; images?: Express.Multer.File[] }) {}

// Any field names
@UseInterceptors(AnyFilesInterceptor())
// Reject all files (form-data only)
@UseInterceptors(NoFilesInterceptor())
```

### Defaults / module config

```typescript
import { MulterModule } from '@nestjs/platform-express';

MulterModule.register({ dest: './upload' });
// or async:
MulterModule.registerAsync({
  inject: [ConfigService],
  useFactory: (c: ConfigService) => ({ dest: c.get('UPLOAD_DIR') }),
});
```

> For S3 presigned uploads, keep files in memory (`memoryStorage`, the default — file lands on `file.buffer`) or skip multer entirely: have the client request a presigned PUT URL from a controller and upload directly to S3, then send only the resulting object key back to the API.

---

## Streaming Files (`StreamableFile`)

Return a `StreamableFile` (wraps a `Buffer` or `Stream`) so Nest pipes the response and still runs interceptors. Works on both Express and Fastify.

```typescript
import { Controller, Get, StreamableFile, Header, Res } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { Response } from 'express';

@Controller('files')
export class FilesController {
  @Get()
  getFile(): StreamableFile {
    const file = createReadStream(join(process.cwd(), 'package.json'));
    return new StreamableFile(file);
  }

  // Set type/disposition via StreamableFile options
  @Get('download')
  download(): StreamableFile {
    const file = createReadStream(join(process.cwd(), 'report.pdf'));
    return new StreamableFile(file, {
      type: 'application/pdf',
      disposition: 'attachment; filename="report.pdf"',
      length: 1024,
    });
  }

  // Or via @Header decorators
  @Get('img')
  @Header('Content-Type', 'image/png')
  @Header('Content-Disposition', 'attachment; filename="img.png"')
  img(): StreamableFile {
    return new StreamableFile(createReadStream('img.png'));
  }

  // Or via response object with passthrough
  @Get('res')
  resStream(@Res({ passthrough: true }) res: Response): StreamableFile {
    res.set({ 'Content-Type': 'application/json' });
    return new StreamableFile(createReadStream('data.json'));
  }
}
```

Stream an S3 object: pass `s3.getObject(...).Body` (a readable stream) to `new StreamableFile(body)`.

---

## Cookies (`cookie-parser`, Express)

Used here for httpOnly JWT cookies. Parse incoming cookies and set secure response cookies.

```bash
pnpm add cookie-parser
pnpm add -D @types/cookie-parser
```

```typescript
// main.ts
import * as cookieParser from 'cookie-parser';
app.use(cookieParser('signing-secret')); // secret optional, enables signed cookies
```

### Reading

```typescript
import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';

@Get()
findAll(@Req() request: Request) {
  const jwt = request.cookies['access_token'];
  const signed = request.signedCookies['access_token']; // when using a secret
}
```

### Setting — httpOnly JWT cookie pattern

Use `@Res({ passthrough: true })` so Nest still handles the return value while you set cookies on the raw response.

```typescript
import { Controller, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

@Post('login')
async login(@Res({ passthrough: true }) res: Response) {
  const token = await this.authService.signJwt(/* ... */);
  res.cookie('access_token', token, {
    httpOnly: true,                            // not accessible to JS — XSS-safe
    secure: process.env.NODE_ENV === 'production', // HTTPS only in prod
    sameSite: 'lax',                           // 'strict' | 'lax' | 'none'
    maxAge: 1000 * 60 * 60 * 24 * 7,           // 7 days in ms
    path: '/',
    // domain: '.queerpulse.app',
  });
  return { ok: true };
}

@Post('logout')
logout(@Res({ passthrough: true }) res: Response) {
  res.clearCookie('access_token', { httpOnly: true, sameSite: 'lax', path: '/' });
  return { ok: true };
}
```

`sameSite: 'none'` requires `secure: true` (cross-site cookies). Reusable param decorator:

```typescript
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const Cookies = createParamDecorator(
  (data: string, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return data ? request.cookies?.[data] : request.cookies;
  },
);
// usage: findAll(@Cookies('access_token') token: string) {}
```

(Fastify equivalent: `@fastify/cookie`, `reply.setCookie(...)`.)

---

## Session (`express-session`)

Server-side session state stored against a session cookie. Prefer stateless JWT cookies for this API; use sessions only if you need server-side revocable state. **Default `MemoryStore` is not for production** — back it with Redis (`connect-redis`).

```bash
pnpm add express-session
pnpm add -D @types/express-session
```

```typescript
// main.ts
import * as session from 'express-session';

app.use(
  session({
    secret: process.env.SESSION_SECRET!,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60,
    },
    // store: new RedisStore({ client: redis }),
  }),
);
```

```typescript
import { Get, Req } from '@nestjs/common';
import type { Request } from 'express';

@Get()
visit(@Req() req: Request) {
  req.session.views = (req.session.views || 0) + 1;
  return req.session.views;
}
```

(Fastify: `@fastify/secure-session` or `@fastify/session`.)

---

## Server-Sent Events (`@Sse`)

One-way server→client streaming over a single HTTP connection (`text/event-stream`). Good for live notification feeds. Return an RxJS `Observable<MessageEvent>`.

```typescript
import { Controller, Sse, MessageEvent } from '@nestjs/common';
import { Observable, interval, map, finalize } from 'rxjs';

@Controller()
export class NotificationsController {
  @Sse('notifications/stream')
  stream(): Observable<MessageEvent> {
    return interval(1000).pipe(
      map((n) => ({ data: { count: n } }) as MessageEvent),
      finalize(() => {
        // cleanup on disconnect/complete
      }),
    );
  }
}
```

`MessageEvent`: `{ data: string | object; id?: string; type?: string; retry?: number }`. Nest auto-unsubscribes on client disconnect.

Client:

```javascript
const es = new EventSource('/notifications/stream', { withCredentials: true });
es.onmessage = ({ data }) => console.log(JSON.parse(data));
es.close();
```

A realistic pattern: bridge a per-user RxJS `Subject` that the EventEmitter listeners push to.

---

## Compression (`compression`, Express)

Gzip/deflate response bodies. For high-traffic prod, offload to a reverse proxy (Nginx) instead.

```bash
pnpm add compression
pnpm add -D @types/compression
```

```typescript
import * as compression from 'compression';
app.use(compression());
```

Fastify: `@fastify/compress` (`await app.register(compression)`); supports Brotli with tunable `BROTLI_PARAM_QUALITY` (0–11) and `encodings: ['gzip', 'deflate']`.

---

## MVC (server-rendered views, Express)

Render HTML with a template engine (`hbs`, `ejs`, etc.). Rarely needed for an API backend; included for completeness.

```bash
pnpm add hbs
```

```typescript
// main.ts
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';

const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.useStaticAssets(join(__dirname, '..', 'public'));
app.setBaseViewsDir(join(__dirname, '..', 'views'));
app.setViewEngine('hbs');
```

```typescript
import { Controller, Get, Render, Res } from '@nestjs/common';
import type { Response } from 'express';

@Controller()
export class AppController {
  @Get()
  @Render('index')                 // views/index.hbs
  root() {
    return { message: 'Hello world!' };
  }

  // Dynamic template name
  @Get('dyn')
  dynamic(@Res() res: Response) {
    return res.render('index', { message: 'Hello' });
  }
}
```

(Fastify MVC uses `@fastify/static` + `@fastify/view`.)
