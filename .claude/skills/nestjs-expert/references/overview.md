# NestJS Overview Reference

Target: NestJS v11, TypeScript, decorators enabled (`experimentalDecorators`, `emitDecoratorMetadata`), Express platform by default. Imports come from `@nestjs/common` unless noted; DI tokens (`APP_GUARD`, etc.) and `Reflector`/`NestFactory` come from `@nestjs/core`.

## Request Lifecycle / Execution Order

Per request, components fire in this order:

1. Middleware (global, then module-bound)
2. **Guards** (global → controller → route)
3. **Interceptors** (pre-controller, "before" half — global → controller → route)
4. **Pipes** (global → controller → route → param)
5. Route **handler** (controller method)
6. **Interceptors** (post-controller, "after" half — reverse order, via the RxJS stream)
7. **Exception filters** (only if anything above throws; most specific scope wins)
8. Server response

Key consequences: a guard returning `false`/throwing short-circuits before interceptors/pipes/handler. Pipes run inside the "exceptions zone," so a pipe throw is caught by filters. Interceptors wrap the handler, so `tap`/`map`/`catchError` in the returned Observable run after the handler resolves.

## First Steps (Bootstrap)

`main.ts` creates and starts the app. `NestFactory.create()` returns an `INestApplication`.

```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

Platforms: **Express** (default, `@nestjs/platform-express`) or **Fastify** (`@nestjs/platform-fastify`). Type the app only when you need the underlying platform API:

```typescript
import { NestExpressApplication } from '@nestjs/platform-express';
const app = await NestFactory.create<NestExpressApplication>(AppModule);
```

## Controllers

`@Controller(prefix)` sets a route prefix. HTTP method decorators: `@Get()`, `@Post()`, `@Put()`, `@Delete()`, `@Patch()`, `@Options()`, `@Head()`, `@All()`. Default status is 200 (201 for POST).

```typescript
import {
  Controller, Get, Post, Put, Delete, Body, Param, Query, HttpCode, Header, Redirect,
} from '@nestjs/common';

@Controller('cats')
export class CatsController {
  @Post()
  @HttpCode(204)                       // override status
  @Header('Cache-Control', 'no-store') // set response header
  create(@Body() dto: CreateCatDto) { return 'created'; }

  @Get()
  findAll(@Query('age') age: number, @Query('breed') breed: string) {
    return `age=${age} breed=${breed}`;
  }

  @Get(':id')                          // route param; declare AFTER static paths
  findOne(@Param('id') id: string) { return `#${id}`; }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCatDto) { return `#${id}`; }

  @Delete(':id')
  remove(@Param('id') id: string) { return `#${id}`; }
}
```

### Parameter Decorators

`@Req()`/`@Request()`, `@Res()`/`@Response()`, `@Next()`, `@Session()`, `@Param(key?)`, `@Body(key?)`, `@Query(key?)`, `@Headers(name?)`, `@Ip()`, `@HostParam()`.

### Wildcards, Redirect, Sub-domain

```typescript
@Get('abcd/*')                       // wildcard route
findWild() { return 'wildcard'; }

@Get('docs')
@Redirect('https://nestjs.com', 301) // static redirect; return {url,statusCode} to override dynamically
getDocs() {}

@Controller({ host: ':account.example.com' })   // sub-domain routing
export class AccountController {
  @Get()
  getInfo(@HostParam('account') account: string) { return account; }
}
```

### DTOs, Async, Library-Specific Response

DTOs must be **classes** (not interfaces) so metadata survives at runtime (needed by `ValidationPipe`). Handlers may return values, `Promise`, or RxJS `Observable`. Using `@Res()` switches to library-specific mode (Nest no longer auto-sends); use `@Res({ passthrough: true })` to set status/headers while still returning a value.

```typescript
@Get()
findAll(@Res({ passthrough: true }) res: Response) {
  res.status(HttpStatus.OK);
  return [];
}
```

Register controllers in a module's `controllers` array.

## Providers

A provider is an `@Injectable()` class (service, repository, factory, helper) managed by Nest's IoC container and resolved by type via constructor injection.

```typescript
import { Injectable } from '@nestjs/common';

@Injectable()
export class CatsService {
  private readonly cats: Cat[] = [];
  create(cat: Cat) { this.cats.push(cat); }
  findAll(): Cat[] { return this.cats; }
}

@Controller('cats')
export class CatsController {
  constructor(private catsService: CatsService) {} // constructor injection by type
}
```

### Custom Providers

Register objects under tokens with one of four strategies:

```typescript
@Module({
  providers: [
    CatsService,                                          // shorthand for { provide: CatsService, useClass: CatsService }
    { provide: 'CONFIG', useValue: { apiKey: 'x' } },     // useValue: constant/mock
    { provide: CatsService, useClass: ProdCatsService },  // useClass: swap implementation
    {                                                     // useFactory: computed, with deps
      provide: 'CONNECTION',
      useFactory: (cfg: ConfigService) => new Conn(cfg.url),
      inject: [ConfigService],
    },
    { provide: 'ALIAS', useExisting: CatsService },       // useExisting: alias to another token
  ],
})
export class CatsModule {}
```

Inject non-class tokens with `@Inject(token)`. `@Optional()` allows a missing dependency. Property injection is available but constructor injection is preferred (unless extending a class):

```typescript
import { Injectable, Optional, Inject } from '@nestjs/common';

@Injectable()
export class HttpService<T> {
  constructor(@Optional() @Inject('HTTP_OPTIONS') private opts: T) {}
  // or property-based:
  // @Inject('HTTP_OPTIONS') private readonly opts: T;
}
```

Scopes: providers are singletons by default; can be made request-scoped (see Injection Scopes docs).

## Modules

`@Module()` metadata: `imports`, `controllers`, `providers`, `exports`. Modules **encapsulate** providers — a provider is only injectable if it belongs to the current module or is exported by an imported module.

```typescript
@Module({
  imports: [CatsModule],
  controllers: [CatsController],
  providers: [CatsService],
  exports: [CatsService],   // make CatsService available to importing modules
})
export class CatsModule {}
```

Modules are singletons; export a provider to share its single instance. Re-export an imported module to pass it through:

```typescript
@Module({ imports: [CommonModule], exports: [CommonModule] })
export class CoreModule {}
```

`@Global()` makes a module's exports available everywhere without importing (use sparingly). Module classes can inject providers but cannot themselves be injected.

### Dynamic Modules

Return a `DynamicModule` from a static method (convention: `forRoot` for global config, `register` for per-import config). Add `global: true` to the returned object for a globally-scoped dynamic module.

```typescript
import { Module, DynamicModule } from '@nestjs/common';

@Module({ providers: [Connection], exports: [Connection] })
export class DatabaseModule {
  static forRoot(entities = [], options?): DynamicModule {
    const providers = createDatabaseProviders(options, entities);
    return { module: DatabaseModule, providers, exports: providers };
  }
}
// usage: imports: [DatabaseModule.forRoot([User])]
```

## Middleware

Runs before route handlers (Express middleware semantics: read/modify req/res, end the cycle, or call `next()`). Class middleware implements `NestMiddleware`; functional middleware is a plain function. Global middleware (`app.use()`) and functional middleware cannot use DI.

```typescript
import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    console.log('Request...');
    next();
  }
}
```

Bind via `configure(consumer: MiddlewareConsumer)` in a module implementing `NestModule`:

```typescript
import { Module, NestModule, MiddlewareConsumer, RequestMethod } from '@nestjs/common';

@Module({ imports: [CatsModule] })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(LoggerMiddleware)
      .exclude({ path: 'cats', method: RequestMethod.GET }, 'cats/{*splat}')
      .forRoutes({ path: 'cats', method: RequestMethod.GET }); // or 'cats' | CatsController
  }
}
```

`apply()` accepts multiple middleware (`apply(cors(), helmet(), logger)`). `forRoutes()` accepts path strings, `{ path, method }`, or controller classes. v11 wildcard syntax uses named splats: `'abcd/*splat'` or optional `'abcd/{*splat}'`. Functional middleware:

```typescript
export function logger(req: Request, res: Response, next: NextFunction) {
  console.log('Request...');
  next();
}
// consumer.apply(logger).forRoutes(CatsController);
// global (no DI): app.use(logger);
```

## Exception Filters

Nest's built-in global filter handles `HttpException` and subclasses; unrecognized errors yield `{ statusCode: 500, message: "Internal server error" }`. `HttpException` constructor: `(response: string|object, status: number, options?: { cause, description })`.

```typescript
import { HttpException, HttpStatus } from '@nestjs/common';

throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
throw new HttpException(
  { status: HttpStatus.FORBIDDEN, error: 'custom' },
  HttpStatus.FORBIDDEN,
  { cause: originalError },
);
```

Built-in exceptions (extend `HttpException`): `BadRequestException`, `UnauthorizedException`, `NotFoundException`, `ForbiddenException`, `NotAcceptableException`, `RequestTimeoutException`, `ConflictException`, `GoneException`, `PayloadTooLargeException`, `UnsupportedMediaTypeException`, `UnprocessableEntityException`, `InternalServerErrorException`, `NotImplementedException`, `ImATeapotException`, `MethodNotAllowedException`, `BadGatewayException`, `ServiceUnavailableException`, `GatewayTimeoutException`, `PreconditionFailedException`, and more.

```typescript
throw new BadRequestException('Something bad', { cause: new Error(), description: 'desc' });
```

### Custom Filter

Implement `ExceptionFilter` with `catch(exception, host)`. `@Catch(...types)` binds exception types; empty `@Catch()` catches everything. Use `ArgumentsHost` (`switchToHttp()`) to reach platform req/res (context-agnostic across HTTP/WS/RPC).

```typescript
import { ExceptionFilter, Catch, ArgumentsHost, HttpException } from '@nestjs/common';
import { Request, Response } from 'express';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const status = exception.getStatus();
    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
```

Catch-all + platform-agnostic via `HttpAdapterHost` (declare catch-all filters BEFORE specific ones):

```typescript
import { Catch, ArgumentsHost, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

@Catch()
export class CatchEverythingFilter implements ExceptionFilter {
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}
  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    httpAdapter.reply(ctx.getResponse(), { statusCode: status, path: httpAdapter.getRequestUrl(ctx.getRequest()) }, status);
  }
}
```

Extend `BaseExceptionFilter` (from `@nestjs/core`) to delegate to the built-in handler via `super.catch()`.

### Binding Filters

`@UseFilters(HttpExceptionFilter)` (class ref preferred — Nest reuses instances) at method or controller scope. Global: `app.useGlobalFilters(new HttpExceptionFilter())` (no DI), or via `APP_FILTER` provider (DI-capable, recommended):

```typescript
import { APP_FILTER } from '@nestjs/core';
@Module({ providers: [{ provide: APP_FILTER, useClass: HttpExceptionFilter }] })
export class AppModule {}
```

## Pipes

`@Injectable()` classes implementing `PipeTransform`. Two roles: **transformation** and **validation**. Run just before the handler, inside the exceptions zone (a throw is handled by filters).

Built-in pipes: `ValidationPipe`, `ParseIntPipe`, `ParseFloatPipe`, `ParseBoolPipe`, `ParseArrayPipe`, `ParseUUIDPipe`, `ParseEnumPipe`, `DefaultValuePipe`, `ParseFilePipe`, `ParseDatePipe`.

```typescript
@Get(':id')
findOne(@Param('id', ParseIntPipe) id: number) { return this.svc.findOne(id); }

@Get(':id')
findById(
  @Param('id', new ParseIntPipe({ errorHttpStatusCode: HttpStatus.NOT_ACCEPTABLE })) id: number,
) {}

@Get()
findAll(
  @Query('activeOnly', new DefaultValuePipe(false), ParseBoolPipe) activeOnly: boolean,
  @Query('page', new DefaultValuePipe(0), ParseIntPipe) page: number,
) {}
```

### Custom Pipe

`transform(value, metadata: ArgumentMetadata)`; `ArgumentMetadata = { type: 'body'|'query'|'param'|'custom'; metatype?: Type; data?: string }`.

```typescript
import { PipeTransform, Injectable, ArgumentMetadata, BadRequestException } from '@nestjs/common';

@Injectable()
export class ParseIntPipe implements PipeTransform<string, number> {
  transform(value: string, metadata: ArgumentMetadata): number {
    const val = parseInt(value, 10);
    if (isNaN(val)) throw new BadRequestException('Validation failed');
    return val;
  }
}
```

### ValidationPipe + class-validator

Requires `class-validator` and `class-transformer` (`pnpm add class-validator class-transformer`). Decorate DTO classes; the metatype must be a class (hence DTOs are classes).

```typescript
import { IsString, IsInt } from 'class-validator';
export class CreateCatDto {
  @IsString() name: string;
  @IsInt() age: number;
}
```

Common options: `whitelist: true` strips properties without validation decorators; `forbidNonWhitelisted: true` throws on extra properties instead; `transform: true` auto-instantiates the DTO class and coerces primitive types (e.g. string param → number). Global registration is typical:

```typescript
import { ValidationPipe } from '@nestjs/common';
app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true })); // no DI
```

### Binding Pipes

Param-level (`@Param('id', ParseIntPipe)`), `@UsePipes(new ZodValidationPipe(schema))` at method/controller scope, `app.useGlobalPipes(...)` (no DI), or `APP_PIPE` provider (DI-capable):

```typescript
import { APP_PIPE } from '@nestjs/core';
@Module({ providers: [{ provide: APP_PIPE, useClass: ValidationPipe }] })
export class AppModule {}
```

## Guards

`@Injectable()` implementing `CanActivate`; `canActivate(context: ExecutionContext)` returns `boolean | Promise<boolean> | Observable<boolean>`. `true` allows, `false`/throw denies (default 403). Guards run after middleware, before interceptors/pipes, and know what will execute next via `ExecutionContext`.

```typescript
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    return validateRequest(request);
  }
}
```

### Metadata + Reflector (Role-Based)

Two metadata styles: `@SetMetadata('roles', ['admin'])` (string key) or the typed `Reflector.createDecorator<string[]>()`. Read with `reflector.get(...)` or, to merge handler + controller scopes, `reflector.getAllAndOverride(KEY, [context.getHandler(), context.getClass()])` (handler wins) or `getAllAndMerge`.

```typescript
import { SetMetadata } from '@nestjs/common';
export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles) return true;
    const { user } = context.switchToHttp().getRequest();
    return matchRoles(roles, user.roles);
  }
}
```

Typed-decorator variant: `export const Roles = Reflector.createDecorator<string[]>();` then `this.reflector.get(Roles, context.getHandler())`.

### Binding Guards

`@UseGuards(RolesGuard)` at controller/method scope, `app.useGlobalGuards(new RolesGuard())` (no DI), or `APP_GUARD` provider (DI-capable, so the guard can inject `Reflector`/services):

```typescript
import { APP_GUARD } from '@nestjs/core';
@Module({ providers: [{ provide: APP_GUARD, useClass: RolesGuard }] })
export class AppModule {}
```

## Interceptors

`@Injectable()` implementing `NestInterceptor`; `intercept(context: ExecutionContext, next: CallHandler): Observable<any>`. Call `next.handle()` to invoke the handler — code before it runs pre-handler, RxJS operators piped onto it run post-handler. Returning a different Observable without calling `next.handle()` overrides the handler (e.g. caching).

```typescript
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, map, catchError, timeout } from 'rxjs/operators';
import { throwError, of, TimeoutError } from 'rxjs';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const now = Date.now();
    return next.handle().pipe(tap(() => console.log(`After ${Date.now() - now}ms`)));
  }
}
```

Common patterns:

```typescript
// Response mapping: wrap payload in { data }
map(data => ({ data }))

// Exception mapping
catchError(err => throwError(() => new BadGatewayException()))

// Override / cache (handler never runs)
intercept(ctx, next) { return isCached ? of([]) : next.handle(); }

// Timeout
next.handle().pipe(
  timeout(5000),
  catchError(err => err instanceof TimeoutError
    ? throwError(() => new RequestTimeoutException())
    : throwError(() => err)),
);
```

### Binding Interceptors

`@UseInterceptors(LoggingInterceptor)` at controller/method scope, `app.useGlobalInterceptors(new LoggingInterceptor())` (no DI), or `APP_INTERCEPTOR` provider (DI-capable):

```typescript
import { APP_INTERCEPTOR } from '@nestjs/core';
@Module({ providers: [{ provide: APP_INTERCEPTOR, useClass: LoggingInterceptor }] })
export class AppModule {}
```

## Custom Decorators

### Custom Param Decorators

`createParamDecorator((data, ctx: ExecutionContext) => value)`. The `data` arg is what the caller passes to the decorator.

```typescript
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const User = createParamDecorator(
  (data: string, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    return data ? user?.[data] : user;   // @User() -> whole user; @User('firstName') -> field
  },
);

@Get()
findOne(@User('firstName') firstName: string) {}
```

Pipes work on custom param decorators; for `ValidationPipe`, set `validateCustomDecorators: true`:

```typescript
@Get()
findOne(@User(new ValidationPipe({ validateCustomDecorators: true })) user: UserEntity) {}
```

### Decorator Composition

`applyDecorators(...)` bundles multiple decorators into one reusable decorator.

```typescript
import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';

export function Auth(...roles: Role[]) {
  return applyDecorators(
    SetMetadata('roles', roles),
    UseGuards(AuthGuard, RolesGuard),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({ description: 'Unauthorized' }),
  );
}

@Get('users')
@Auth('admin')   // applies all four at once
findAllUsers() {}
```

## Global Binding Tokens Summary

| Component | Per-route/controller | Global (no DI) | Global (DI-capable provider token) |
|-----------|----------------------|----------------|-------------------------------------|
| Guard | `@UseGuards()` | `app.useGlobalGuards()` | `APP_GUARD` |
| Interceptor | `@UseInterceptors()` | `app.useGlobalInterceptors()` | `APP_INTERCEPTOR` |
| Pipe | `@UsePipes()` / param-level | `app.useGlobalPipes()` | `APP_PIPE` |
| Filter | `@UseFilters()` | `app.useGlobalFilters()` | `APP_FILTER` |

All `APP_*` tokens are imported from `@nestjs/core` and registered as `{ provide: APP_X, useClass: ... }` in a module's `providers`. Prefer the provider-token form when the component must inject other providers.
