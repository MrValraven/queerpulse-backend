# NestJS Security & Authentication Reference

Target: **NestJS v11 + TypeScript**. Covers the official docs pages: authentication, authorization, passport recipe, encryption-and-hashing, helmet, cors, csrf, rate-limiting. Project context: Passport Google OAuth 2.0, app-issued JWT (access + refresh) in httpOnly SameSite cookies, role/status guards, `@nestjs/throttler`, CORS with credentials, CSRF for cookie auth. Code blocks are taken verbatim from the docs where applicable, with project-specific additions clearly marked.

Install matrix:
```bash
pnpm add @nestjs/passport passport passport-local passport-jwt passport-google-oauth20 @nestjs/jwt
pnpm add -D @types/passport-local @types/passport-jwt @types/passport-google-oauth20
pnpm add bcrypt          # or: pnpm add argon2
pnpm add -D @types/bcrypt
pnpm add helmet @nestjs/throttler cookie-parser csrf-csrf
pnpm add -D @types/cookie-parser
```

## Authentication: app-issued JWT without Passport

The plain `@nestjs/jwt` approach (no Passport). Useful for the simplest setups and to understand what Passport wraps.

### AuthService.signIn — issuing the token

```typescript
// auth/auth.service.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  async signIn(username: string, pass: string): Promise<{ access_token: string }> {
    const user = await this.usersService.findOne(username);
    if (user?.password !== pass) {       // real apps: bcrypt.compare / argon2.verify
      throw new UnauthorizedException();
    }
    const payload = { sub: user.userId, username: user.username }; // `sub` per JWT standard
    return {
      // JWT secret used for signing comes from JwtModule config
      access_token: await this.jwtService.signAsync(payload),
    };
  }
}
```
Strip the password before returning user objects: `const { password, ...result } = user;`. `JwtService` exposes `sign`/`signAsync` and `verify`/`verifyAsync` (and `decode`).

### JwtModule.register — secret and constants

```typescript
// auth/constants.ts
export const jwtConstants = {
  secret: 'DO NOT USE THIS VALUE. CREATE A COMPLEX SECRET, KEEP IT SAFE OUTSIDE SOURCE.',
};
```
```typescript
// auth/auth.module.ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { jwtConstants } from './constants';

@Module({
  imports: [
    UsersModule,
    JwtModule.register({
      global: true,                       // no need to import JwtModule elsewhere
      secret: jwtConstants.secret,
      signOptions: { expiresIn: '60s' },  // `@nestjs/jwt` auto-enforces exp on verify
    }),
  ],
  providers: [AuthService],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
```

**`registerAsync` (recommended for production — load secret from `ConfigService`):**
```typescript
JwtModule.registerAsync({
  global: true,
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    signOptions: { expiresIn: config.get('JWT_ACCESS_TTL', '15m') },
  }),
});
```

### Custom AuthGuard with JwtService.verifyAsync

```typescript
// auth/auth.guard.ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);
    if (!token) throw new UnauthorizedException();
    try {
      const payload = await this.jwtService.verifyAsync(token);
      request['user'] = payload;          // attach payload so handlers can read req.user
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
```
Apply per-route with `@UseGuards(AuthGuard)`; `@Request() req` then exposes `req.user`.

### Enable globally + @Public route metadata

Register as a global guard (in any module's providers):
```typescript
import { APP_GUARD } from '@nestjs/core';
providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
```
```typescript
// auth/decorators/public.decorator.ts
import { SetMetadata } from '@nestjs/common';
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```
Make the guard honor it via `Reflector.getAllAndOverride`:
```typescript
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService, private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    // ...token extraction + verifyAsync as above
  }
}
```
Usage: `@Public()` above a handler (`@Get()`) skips auth. (`Reflector` from `@nestjs/core`.)

## Authentication: Passport integration (@nestjs/passport)

Passport executes: authenticate credentials → manage state (issue token/session) → attach user to `Request`. With `@nestjs/passport` you extend `PassportStrategy(Strategy)`, pass options via `super(options)`, and supply the verify callback as `validate()`. Each strategy auto-provisions an `AuthGuard('<name>')`.

`AuthModule` must import `PassportModule` and register strategies in `providers`.

### AuthService.validateUser + login (Passport variant)

```typescript
// auth/auth.service.ts
@Injectable()
export class AuthService {
  constructor(private usersService: UsersService, private jwtService: JwtService) {}

  async validateUser(username: string, pass: string): Promise<any> {
    const user = await this.usersService.findOne(username);
    if (user && user.password === pass) {     // real apps: hash compare
      const { password, ...result } = user;
      return result;
    }
    return null;                              // null => Passport treats as auth failure
  }

  async login(user: any) {
    const payload = { username: user.username, sub: user.userId };
    return { access_token: this.jwtService.sign(payload) };
  }
}
```

### LocalStrategy + LocalAuthGuard

```typescript
// auth/local.strategy.ts
import { Strategy } from 'passport-local';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private authService: AuthService) {
    super(); // pass { usernameField: 'email' } to change the expected body field
  }

  async validate(username: string, password: string): Promise<any> {
    const user = await this.authService.validateUser(username, password);
    if (!user) throw new UnauthorizedException();
    return user; // becomes req.user
  }
}
```
`passport-local` `validate()` signature is `(username, password)`, reading `username`/`password` from the request body by default. Prefer a named guard over the magic string:
```typescript
// auth/local-auth.guard.ts
@Injectable()
export class LocalAuthGuard extends AuthGuard('local') {}
```
```typescript
@UseGuards(LocalAuthGuard)
@Post('auth/login')
async login(@Request() req) {
  return this.authService.login(req.user); // req.user set by LocalStrategy.validate()
}
```
Logout (session-based only, not JWT): `req.logout()`.

### JwtStrategy with passport-jwt (Bearer header)

```typescript
// auth/jwt.strategy.ts
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';
import { jwtConstants } from './constants';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,          // let Passport reject expired tokens (401)
      secretOrKey: jwtConstants.secret, // must match signing secret
    });
  }

  async validate(payload: any) {
    // signature already verified; enrich here (DB lookup, revocation check, etc.)
    return { userId: payload.sub, username: payload.username }; // becomes req.user
  }
}
```
`validate()` may return an array `[user, authInfo]`. Register `JwtStrategy` in `AuthModule` providers, and define the guard:
```typescript
// auth/jwt-auth.guard.ts
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
```
```typescript
@UseGuards(JwtAuthGuard)
@Get('profile')
getProfile(@Request() req) { return req.user; }
```

### JwtStrategy reading the token from a cookie (project pattern)

For httpOnly cookie auth (no Authorization header), supply a custom extractor via `ExtractJwt.fromExtractors`. You can chain Bearer + cookie extraction.

```typescript
// auth/jwt-cookie.strategy.ts
import { ExtractJwt, Strategy, JwtFromRequestFunction } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';
import { Request } from 'express';
import { ConfigService } from '@nestjs/config';

// Reads the access token from an httpOnly cookie named "access_token".
const cookieExtractor: JwtFromRequestFunction = (req: Request) => {
  return req?.cookies?.['access_token'] ?? null; // requires cookie-parser middleware
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        cookieExtractor,                            // cookie first
        ExtractJwt.fromAuthHeaderAsBearerToken(),   // fallback to Bearer header
      ]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: { sub: string; email: string; role: string; status: string }) {
    return { userId: payload.sub, email: payload.email, role: payload.role, status: payload.status };
  }
}
```
Enable `app.use(cookieParser())` in `main.ts` so `req.cookies` is populated. A **refresh** strategy is a second named strategy (`PassportStrategy(Strategy, 'jwt-refresh')`) reading a `refresh_token` cookie and using `JWT_REFRESH_SECRET`; commonly set `passReqToCallback: true` to access the raw token for rotation/DB comparison.

**Issuing both tokens into httpOnly SameSite cookies:**
```typescript
@Post('auth/login')
async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
  const { accessToken, refreshToken } = await this.authService.login(dto);
  const common = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' };
  res.cookie('access_token',  accessToken,  { ...common, maxAge: 15 * 60 * 1000 });
  res.cookie('refresh_token', refreshToken, { ...common, maxAge: 7 * 24 * 60 * 60 * 1000 });
  return { ok: true };
}
```
Notes: `sameSite: 'lax'` works for same-site/top-level nav; use `'none'` + `secure: true` for cross-site SPAs (then CSRF protection is required). `@Res({ passthrough: true })` keeps Nest's response handling.

### Extending guards (custom error handling / strategy chaining)

```typescript
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    // custom logic; super.logIn(request) to establish a session if needed
    return super.canActivate(context);
  }
  handleRequest(err, user, info) {
    if (err || !user) throw err || new UnauthorizedException();
    return user;
  }
}
```
Strategy chain (first to succeed/redirect/error halts): `AuthGuard(['strategy_jwt_1', 'strategy_jwt_2'])`.

### Global JWT guard + @Public (Passport variant)

```typescript
providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
```
```typescript
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) { super(); }
  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(), context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}
```

### Named strategies, request-scoped, GraphQL

- **Named:** `PassportStrategy(Strategy, 'myjwt')` → reference via `@UseGuards(AuthGuard('myjwt'))`.
- **Request-scoped resolution inside a strategy:** strategies register on the global Passport instance, so they cannot be request-scoped. Inject `ModuleRef` (`@nestjs/core`), set `super({ passReqToCallback: true })`, then in `validate()`:
  ```typescript
  const contextId = ContextIdFactory.getByRequest(request);
  const authService = await this.moduleRef.resolve(AuthService, contextId);
  ```
- **Customize Passport module:** `PassportModule.register({ session: true })`.
- **GraphQL:** override `getRequest()` to pull `ctx.getContext().req` from `GqlExecutionContext`; define a `@CurrentUser()` param decorator via `createParamDecorator`. For passport-local under GraphQL, also merge `gqlArgs` into `req.body`.

## Passport recipe: Google OAuth 2.0 (passport-google-oauth20)

GoogleStrategy uses OAuth2 redirect flow. `validate(accessToken, refreshToken, profile, done)` is the verify callback; call `done(null, user)` to attach `user` to `req.user`.

```typescript
// auth/google.strategy.ts
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback, Profile } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: ConfigService, private authService: AuthService) {
    super({
      clientID: config.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      clientSecret: config.getOrThrow<string>('GOOGLE_CLIENT_SECRET'),
      callbackURL: config.getOrThrow<string>('GOOGLE_CALLBACK_URL'), // e.g. http://localhost:3000/auth/google/callback
      scope: ['email', 'profile'],
    });
  }

  // Called after Google redirects back. Verify/upsert the user, then done().
  async validate(
    accessToken: string,
    refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): Promise<void> {
    const { id, name, emails, photos } = profile;
    const user = await this.authService.validateOrCreateOAuthUser({
      provider: 'google',
      providerId: id,
      email: emails?.[0]?.value,
      firstName: name?.givenName,
      lastName: name?.familyName,
      picture: photos?.[0]?.value,
    });
    done(null, user); // -> req.user. Pass an error as first arg to fail auth.
  }
}
```

```typescript
// auth/google-auth.guard.ts
@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {}
```

```typescript
// auth/auth.controller.ts
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google')
  googleAuth() {
    // Guard triggers redirect to Google's consent screen; body never runs.
  }

  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google/callback')
  async googleCallback(@Request() req, @Res({ passthrough: true }) res: Response) {
    // req.user is the object returned from GoogleStrategy.validate()
    const { accessToken, refreshToken } = await this.authService.login(req.user);
    res.cookie('access_token', accessToken, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    res.cookie('refresh_token', refreshToken, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    return res.redirect(this.authService.frontendRedirectUrl());
  }
}
```
Register `GoogleStrategy` in `AuthModule` providers. The two routes are marked `@Public()` because the global JWT guard would otherwise block the unauthenticated OAuth start.

## Authorization

Authorization is orthogonal to authentication but depends on it (`request.user` must be populated by an auth guard first).

### RBAC: @Roles + RolesGuard + Reflector.getAllAndOverride

```typescript
// enums/role.enum.ts
export enum Role { User = 'user', Admin = 'admin' }
```
```typescript
// auth/decorators/roles.decorator.ts
import { SetMetadata } from '@nestjs/common';
import { Role } from '../../enums/role.enum';
export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
```
```typescript
// auth/guards/roles.guard.ts
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles) return true;                       // no @Roles => allow
    const { user } = context.switchToHttp().getRequest();
    return requiredRoles.some((role) => user.roles?.includes(role));
  }
}
```
Usage and registration:
```typescript
@Post()
@Roles(Role.Admin)
create(@Body() dto: CreateCatDto) { /* ... */ }

// register at controller or globally:
providers: [{ provide: APP_GUARD, useClass: RolesGuard }],
```
`User` shape must expose roles: `class User { roles: Role[] }`. Insufficient privilege auto-returns `403 { statusCode: 403, message: "Forbidden resource", error: "Forbidden" }`. To customize, throw your own exception instead of returning a boolean. With a global JWT guard + global `RolesGuard`, ordering matters — the auth guard must run first so `req.user` exists.

**Status-based guard (project pattern):** identical structure to `RolesGuard` but checks an account-status claim. Define `@RequireStatus(...statuses)` (`SetMetadata`) and a `StatusGuard` that reads `user.status` (e.g. allow only `ACTIVE`, reject `BANNED`/`PENDING`). Put status in the JWT payload so the guard needs no DB hit.

### Claims-based authorization

Same mechanics as RBAC but compare **permissions** (what the subject can do) instead of roles. Define `@RequirePermissions(...permissions)` and check `user.permissions`. `Permission` is an enum of all available permissions.
```typescript
@Post()
@RequirePermissions(Permission.CREATE_CAT)
create(@Body() dto: CreateCatDto) { /* ... */ }
```

### ABAC with CASL (brief)

`@casl/ability` scales from claims to attribute-based rules. Build an `Ability` per user, then check `ability.can(action, subject)`.
```typescript
// casl/casl-ability.factory.ts (CASL v6 — MongoAbility default)
export enum Action { Manage = 'manage', Create = 'create', Read = 'read', Update = 'update', Delete = 'delete' }
type Subjects = InferSubjects<typeof Article | typeof User> | 'all';
export type AppAbility = MongoAbility<[Action, Subjects]>;

@Injectable()
export class CaslAbilityFactory {
  createForUser(user: User) {
    const { can, cannot, build } = new AbilityBuilder(createMongoAbility);
    if (user.isAdmin) can(Action.Manage, 'all');         // 'manage' = any action; 'all' = any subject
    else              can(Action.Read, 'all');
    can(Action.Update, Article, { authorId: user.id });  // condition-based (Mongo-like)
    cannot(Action.Delete, Article, { isPublished: true });
    return build({ detectSubjectType: (item) => item.constructor as ExtractSubjectType<Subjects> });
  }
}
```
Export `CaslAbilityFactory` from `CaslModule` (providers + exports). Policy-driven guard:
```typescript
interface IPolicyHandler { handle(ability: AppAbility): boolean; }
type PolicyHandlerCallback = (ability: AppAbility) => boolean;
export type PolicyHandler = IPolicyHandler | PolicyHandlerCallback;

export const CHECK_POLICIES_KEY = 'check_policy';
export const CheckPolicies = (...handlers: PolicyHandler[]) => SetMetadata(CHECK_POLICIES_KEY, handlers);

@Injectable()
export class PoliciesGuard implements CanActivate {
  constructor(private reflector: Reflector, private caslAbilityFactory: CaslAbilityFactory) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handlers = this.reflector.get<PolicyHandler[]>(CHECK_POLICIES_KEY, context.getHandler()) || [];
    const { user } = context.switchToHttp().getRequest();
    const ability = this.caslAbilityFactory.createForUser(user);
    return handlers.every((h) => (typeof h === 'function' ? h(ability) : h.handle(ability)));
  }
}
```
```typescript
@Get()
@UseGuards(PoliciesGuard)
@CheckPolicies((ability: AppAbility) => ability.can(Action.Read, Article))
findAll() { /* ... */ }
```
Note: class handlers are instantiated with `new` in the decorator, so they cannot use DI directly — pass a `Type<IPolicyHandler>` and resolve via `ModuleRef#get`/`create` if DI is needed.

## Encryption and Hashing

Node's built-in `crypto` module; Nest adds no wrapper. Encryption is two-way (AES); hashing is one-way (bcrypt/argon2/sha-256).

### AES encryption/decryption (aes-256-ctr)

```typescript
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const iv = randomBytes(16);
const key = (await promisify(scrypt)('Password used to generate key', 'salt', 32)) as Buffer; // 32 bytes for aes256
const cipher = createCipheriv('aes-256-ctr', key, iv);
const encryptedText = Buffer.concat([cipher.update('Nest'), cipher.final()]);

const decipher = createDecipheriv('aes-256-ctr', key, iv);
const decryptedText = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
```

### bcrypt — password hashing (docs default)

```typescript
import * as bcrypt from 'bcrypt';

const saltOrRounds = 10;                                  // cost factor
const hash = await bcrypt.hash('random_password', saltOrRounds);
const salt = await bcrypt.genSalt();                      // optional explicit salt
const isMatch = await bcrypt.compare('random_password', hash);
```

### argon2 — password/token hashing (recommended modern alternative)

```typescript
import * as argon2 from 'argon2';

// argon2id by default; tune memoryCost/timeCost/parallelism for your hardware
const hash = await argon2.hash('random_password');
const isMatch = await argon2.verify(hash, 'random_password'); // (hash, plain)
```
Use the same pattern to hash **refresh tokens** before storing them in the DB (store `argon2.hash(refreshToken)`, verify on rotation), so a DB leak can't replay tokens.

### SHA-256 (crypto.createHash) — non-secret digests

```typescript
import { createHash } from 'node:crypto';
const digest = createHash('sha256').update('value-to-hash').digest('hex');
```
SHA-256 is fast and **unsalted** — never use it for passwords (use bcrypt/argon2). Fine for content fingerprints, opaque-token lookup keys, ETags, etc.

## Helmet

Sets security-related HTTP headers. **Must be registered before any route/`app.use()`** — middleware applies only to routes defined after it.

### Express (default)
```typescript
// main.ts
import helmet from 'helmet';
app.use(helmet());
```

### Fastify
```typescript
import helmet from '@fastify/helmet';
await app.register(helmet);  // Fastify plugin, not middleware
```
With `@apollo/server` + Apollo Sandbox, relax CSP (`crossOriginEmbedderPolicy: false` + a `contentSecurityPolicy.directives` allowlist), or set `contentSecurityPolicy: false` to disable entirely.

## CORS

Backed by `cors` (Express) / `@fastify/cors` (Fastify).

### enableCors with credentials (project pattern)

For cookie-based auth from a browser SPA you **must** set an explicit origin (wildcard `*` is rejected when credentials are sent) and `credentials: true`.
```typescript
// main.ts
const app = await NestFactory.create(AppModule);
app.enableCors({
  origin: ['https://app.queerpulse.com', 'http://localhost:5173'], // exact origins, not '*'
  credentials: true,                  // allow cookies / Authorization across origins
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
});
await app.listen(process.env.PORT ?? 3000);
```
Alternative: `NestFactory.create(AppModule, { cors: true })` or `{ cors: { origin, credentials: true } }`. `origin` also accepts a function/callback for dynamic per-request decisions. The browser only sends/stores credentialed cookies cross-origin when both `credentials: true` here and `withCredentials`/`credentials: 'include'` on the client are set.

## CSRF Protection

Needed when auth relies on cookies sent automatically by the browser (the project's httpOnly cookie JWT). The `csrf-csrf` package implements the double-submit-cookie pattern.

### Express (default) with csrf-csrf

Requires `cookie-parser` (or session middleware) initialized **before** it.
```typescript
// main.ts
import cookieParser from 'cookie-parser';
import { doubleCsrf } from 'csrf-csrf';

app.use(cookieParser());

const {
  invalidCsrfTokenError, // exported for building your own middleware
  generateToken,         // call in a route to issue the CSRF token + cookie
  validateRequest,       // convenience validator
  doubleCsrfProtection,  // the protection middleware
} = doubleCsrf({
  getSecret: () => process.env.CSRF_SECRET,
  cookieName: '__Host-psifi.x-csrf-token',
  cookieOptions: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
  getTokenFromRequest: (req) => req.headers['x-csrf-token'], // client echoes token in header
});
app.use(doubleCsrfProtection);
```
Flow: expose a `GET /csrf-token` route returning `generateToken(req, res)`; the SPA reads it and sends it back in the `X-CSRF-Token` header on mutating requests. The middleware validates the header against the signed cookie. Safe methods (GET/HEAD/OPTIONS) are ignored by default; `@Public()`/CORS preflight still apply.

### Fastify
```typescript
import fastifyCsrf from '@fastify/csrf-protection';
await app.register(fastifyCsrf); // requires a storage plugin registered first
```

## Rate Limiting (@nestjs/throttler)

Protects against brute-force. `ttl` is in **milliseconds** (v5+).

### ThrottlerModule.forRoot + global ThrottlerGuard

```typescript
// app.module.ts
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60000, limit: 10 }], // 10 requests / 60s globally
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
```

### Named throttlers

```typescript
ThrottlerModule.forRoot([
  { name: 'short',  ttl: 1000,  limit: 3 },
  { name: 'medium', ttl: 10000, limit: 20 },
  { name: 'long',   ttl: 60000, limit: 100 },
]);
```

### @Throttle and @SkipThrottle

```typescript
// override limit/ttl per route/class; key is the throttler name ('default' if unnamed)
@Throttle({ default: { limit: 3, ttl: 60000 } })
@Get()
findAll() { /* ... */ }
```
```typescript
@SkipThrottle()                       // skip for whole controller
@Controller('users')
export class UsersController {
  @SkipThrottle({ default: false })   // re-enable for this route
  dontSkip() {}
  doSkip() {}                         // skipped
}
```
Tight limit for sensitive routes (project pattern):
```typescript
@Throttle({ default: { limit: 5, ttl: 60000 } })
@Post('auth/login')
login() { /* ... */ }
```

### Async config, proxies, storage, helpers

- **Async:** `ThrottlerModule.forRootAsync({ imports, inject, useFactory })` or `useClass` (must implement `ThrottlerOptionsFactory`).
- **Behind a proxy:** `app.set('trust proxy', 'loopback')` (Express) so `req.ip`/`X-Forwarded-For` is correct; override `getTracker(req)` in a `ThrottlerGuard` subclass to use `req.ips[0]`.
- **Storage:** in-memory by default; supply any class implementing `ThrottlerStorage` (e.g. Redis provider) via the `storage` option for distributed deployments.
- **Time helpers:** `seconds`, `minutes`, `hours`, `days`, `weeks` from `@nestjs/throttler` (e.g. `ttl: minutes(1)`).
- **Per-throttler config keys:** `name`, `ttl`, `limit`, `blockDuration`, `ignoreUserAgents`, `skipIf(context)`; root-level extras: `storage`, `throttlers`, `errorMessage`, `getTracker`, `generateKey`.
- **WebSockets/GraphQL:** extend `ThrottlerGuard` and override `handleRequest` (WS) or `getRequestResponse` (GraphQL); WS guard cannot be bound via `APP_GUARD`.

## Project wiring checklist (QueerPulse)

1. `main.ts`: `app.use(cookieParser())` → `app.use(helmet())` → `app.enableCors({ origin, credentials: true })` → `app.use(doubleCsrfProtection)` (order matters; security middleware before routes).
2. `JwtModule.registerAsync` with `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` from `ConfigService`; short access TTL (~15m), longer refresh TTL (~7d).
3. Two Passport JWT strategies (`'jwt'` access, `'jwt-refresh'` refresh) using cookie extractors; `GoogleStrategy` for OAuth login.
4. Global guards in order: `JwtAuthGuard` (honors `@Public()`) → `RolesGuard` → `StatusGuard`; OAuth routes marked `@Public()`.
5. Hash passwords with bcrypt/argon2; hash stored refresh tokens with argon2 and verify on rotation.
6. Global `ThrottlerGuard`; tighten `@Throttle` on auth endpoints.
7. Cookies: `httpOnly: true`, `secure: true` (prod), `sameSite: 'lax'` (or `'none'` for cross-site SPA + mandatory CSRF).
