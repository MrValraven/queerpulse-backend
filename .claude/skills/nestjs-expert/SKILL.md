---
name: nestjs-expert
description: >-
  Use when building, designing, reviewing, or debugging anything in this NestJS
  (v11) backend — controllers, providers, modules, dependency injection, guards,
  interceptors, pipes, exception filters, custom decorators, TypeORM
  entities/repositories/migrations, Passport + JWT/cookie auth, WebSocket
  (socket.io) gateways, class-validator DTOs, @nestjs/config, throttling, CORS,
  CSRF, serialization, scheduling/queues/events, file upload, unit + e2e
  testing, or OpenAPI. Also use when unsure of an exact NestJS API signature or
  the idiomatic Nest way to structure a feature.
---

# NestJS Expert

## Overview

A comprehensive, project-tailored reference for **NestJS v11 + TypeScript**,
built verbatim from the official NestJS documentation source. Use it to write
idiomatic, production-grade Nest code for the **QueerPulse backend** and to look
up exact decorator signatures, module wiring, and lifecycle/DI semantics instead
of guessing from memory.

**Core principle:** NestJS is dependency injection + a small set of composable
request-lifecycle primitives (guards → interceptors → pipes → handler →
interceptors → filters). Get the primitive and the module wiring right and the
rest follows.

## When to Use

Use this skill whenever a task touches NestJS:

- Wiring a new feature module (controller / service / repository / DTOs).
- Auth: Passport Google OAuth, JWT access/refresh in httpOnly cookies, guards.
- Persistence: TypeORM entities, relations, repositories, transactions,
  migrations, soft-delete.
- Cross-cutting: validation pipes, serialization, interceptors, exception
  filters, custom param decorators, throttling, CORS, CSRF.
- Real-time: `@WebSocketGateway` (socket.io), authenticated handshake, presence.
- Testing: `Test.createTestingModule`, mocked providers, supertest e2e.
- Any "how do I do X in NestJS / what's the exact signature" question.

**Always read the relevant reference file before writing Nest code** — the exact
API is there. Don't reconstruct decorator options from memory.

## Reference Map — route the task to a file

All files are in [references/](references/). Open the one(s) that match:

| Task / topic | Reference file |
| --- | --- |
| Controllers, providers, modules, middleware, **guards, interceptors, pipes, exception filters, custom decorators**, request lifecycle/execution order | [references/overview.md](references/overview.md) |
| **DI deep-dive**: custom/async providers, dynamic modules (`forRoot`/`forRootAsync`, `ConfigurableModuleBuilder`), injection scopes, circular deps (`forwardRef`), `ModuleRef`, lazy loading, lifecycle hooks (shutdown), **unit + e2e testing** | [references/fundamentals.md](references/fundamentals.md) |
| **@nestjs/config**, **TypeORM/Postgres** (entities, relations, repositories, transactions, migrations, soft-delete), **class-validator DTOs**, serialization (`ClassSerializerInterceptor`), caching, versioning, HttpModule, throttler | [references/techniques-data.md](references/techniques-data.md) |
| Task scheduling (`@nestjs/schedule`), queues (BullMQ), **events (`@nestjs/event-emitter`)**, logging, **file upload (multer)** + validators, streaming files, **cookies**, session, SSE, compression, MVC | [references/techniques-ops.md](references/techniques-ops.md) |
| **Authentication** (Passport, JWT, **Google OAuth**, cookie token extraction), **authorization** (RBAC `@Roles`/`RolesGuard`, CASL), encryption/hashing (bcrypt/argon2/sha-256), Helmet, **CORS**, **CSRF**, **rate limiting** | [references/security-auth.md](references/security-auth.md) |
| **WebSocket gateways** (socket.io), WS guards/pipes/filters/interceptors, authenticated handshake, rooms/presence, **Redis adapter** for scale-out | [references/websockets.md](references/websockets.md) |
| **OpenAPI/Swagger** (DocumentBuilder, `@Api*` decorators, CLI plugin, security schemes), **Nest CLI** (`nest g resource`, build/watch), HMR, graceful shutdown | [references/openapi-cli.md](references/openapi-cli.md) |

## Project Stack (match it exactly)

- **NestJS v11** (Express), **TypeScript**, **pnpm** (never npm/yarn).
- **PostgreSQL + TypeORM** — data-mapper; `synchronize: false`; UUID PKs;
  snake_case columns; `created_at`/`updated_at`; soft-delete via
  `@DeleteDateColumn`. Migrations, not auto-sync, in prod.
- **Auth** — Google OAuth (`passport-google-oauth20`) → app-issued **JWT**
  (access ~15m + refresh ~30d) in **httpOnly, SameSite cookies**; DB-backed
  refresh-token allowlist with rotation + reuse detection. Guards:
  `JwtAuthGuard`, `ActiveMemberGuard` (status === 'active'), `RolesGuard`.
- **Validation** — global `ValidationPipe({ whitelist: true,
  forbidNonWhitelisted: true, transform: true })`; DTOs for every body; never
  bind entities to requests; derive update DTOs with `@nestjs/mapped-types`.
- **Real-time** — `@WebSocketGateway` (socket.io), namespace `/chat`,
  JWT-authenticated handshake, in-memory presence behind a swappable service.
- **Config** — `@nestjs/config` (`.env`); **`@nestjs/throttler`** rate limiting;
  CORS with `credentials: true`; CSRF for cookie auth.
- **Responses** — camelCase JSON, ISO-8601 timestamps, error envelope
  `{ statusCode, message, error }`.

Full product/data spec:
[docs/superpowers/specs/2026-06-29-queerpulse-backend-mvp-design.md](../../../docs/superpowers/specs/2026-06-29-queerpulse-backend-mvp-design.md).
Modules to build: `auth`, `users`/`profiles`, `membership`, `vouch`,
`connections`, `messaging`, `events`, `notifications`.

## Quick Reference — pick the right primitive

| Need | Use | Bind with |
| --- | --- | --- |
| Block/allow a request (authz, status, roles) | **Guard** (`CanActivate`) | `@UseGuards()` / `APP_GUARD` |
| Validate / transform input | **Pipe** (`ValidationPipe`, `ParseUUIDPipe`) | `@UsePipes()` / `APP_PIPE` / param-level |
| Wrap handler (serialize, log, timeout, map result) | **Interceptor** (`NestInterceptor`) | `@UseInterceptors()` / `APP_INTERCEPTOR` |
| Shape error responses | **Exception filter** (`@Catch`) | `@UseFilters()` / `APP_FILTER` |
| Inject ergonomic request data (`@CurrentUser()`) | **Custom param decorator** (`createParamDecorator`) | param position |
| Run before the route (logging, raw req) | **Middleware** | `configure(consumer)` in module |

Execution order: **middleware → guards → interceptors (pre) → pipes → handler →
interceptors (post) → exception filters**. Global `app.useGlobalX()` and
functional middleware **cannot inject** dependencies — use the `APP_*` provider
tokens when you need DI.

## Working Conventions

1. **Ground every answer in a reference file + the spec.** Confirm the exact
   API and the project's decided behavior first.
2. **One feature module per domain**, controller → service → repository. Register
   `providers`/`exports` correctly; reach for `forwardRef` only when truly
   unavoidable (prefer restructuring).
3. **DTOs + validation always.** class-validator decorators on every body;
   `PartialType`/`PickType`/`OmitType` for derived DTOs.
4. **Respect decided semantics** from the spec: idempotent
   promotion/RSVP/vouch/accept; DB-level uniqueness; soft-delete messages;
   events use `status='cancelled'`; conversation materialized on connection
   accept.
5. **Test** (`*.spec.ts` colocated unit, `test/` e2e with supertest) and run
   `pnpm run lint` + relevant `pnpm run test` before claiming done. Report real
   output — never assert success you didn't verify.
6. **Delegating?** The `nestjs-expert` **agent** (in `.claude/agents/`) is the
   subagent form of this knowledge — dispatch it for self-contained NestJS
   implementation tasks.

## Common Mistakes

- Reconstructing decorator options from memory → wrong/renamed options. **Read
  the reference.**
- Binding a TypeORM entity directly to a request body instead of a DTO.
- Forgetting `transform: true` (DTO instances stay plain objects; `@Type()`
  nested validation silently no-ops) or omitting `class-transformer`.
- Expecting global pipes/guards registered via `app.useGlobalX()` to inject
  services — they can't; use `APP_*` tokens.
- `@ValidateNested()` without `@Type(() => Dto)`.
- `synchronize: true` in production (data loss) — use migrations.
- Reading the JWT from the `Authorization` header when this project sends it in
  an httpOnly **cookie** — use `ExtractJwt.fromExtractors([...])`.
- Catch-all exception filter declared **after** specific ones (order matters).
