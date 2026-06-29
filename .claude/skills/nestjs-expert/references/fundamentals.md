# NestJS Fundamentals Reference

Target: NestJS v11 + TypeScript. Sourced verbatim from the official NestJS docs (content/fundamentals). Covers custom & async providers, dynamic modules + ConfigurableModuleBuilder, injection scopes, circular dependencies, ModuleRef, lazy loading, execution context, lifecycle events, platform agnosticism, and testing.

## Custom Providers

Dependency injection is an IoC technique: the Nest runtime instantiates dependencies for you. Three steps make standard DI work:

1. `@Injectable()` marks a class as manageable by the IoC container.
2. A constructor declares a dependency on a token (`constructor(private catsService: CatsService)`).
3. The module registers the provider, associating a **token** with a value.

`@Injectable()` provider:

```typescript
import { Injectable } from '@nestjs/common';
import { Cat } from './interfaces/cat.interface';

@Injectable()
export class CatsService {
  private readonly cats: Cat[] = [];

  findAll(): Cat[] {
    return this.cats;
  }
}
```

Dependency analysis happens at bootstrap and is **transitive** ("creating the dependency graph"), resolving bottom-up. Under SINGLETON (default) scope, Nest creates and caches one instance per token.

> Hint: set the `NEST_DEBUG` env variable for extra dependency-resolution logs during startup.

### Standard providers

`providers: [CatsService]` is shorthand for the full form. The token here equals the class:

```typescript
providers: [
  {
    provide: CatsService,
    useClass: CatsService,
  },
];
```

### useValue (Value providers)

Inject a constant, an external library, or a mock. Requires a value with a compatible interface (TypeScript structural typing — literal object or `new`-instantiated class both work).

```typescript
import { CatsService } from './cats.service';

const mockCatsService = {
  /* mock implementation ... */
};

@Module({
  imports: [CatsModule],
  providers: [
    {
      provide: CatsService,
      useValue: mockCatsService,
    },
  ],
})
export class AppModule {}
```

### Non-class-based provider tokens + @Inject

Tokens may be strings, JavaScript symbols, or TypeScript enums. Standard constructor injection requires a class token, so non-class tokens **must** be injected with `@Inject(token)` (from `@nestjs/common`).

```typescript
import { connection } from './connection';

@Module({
  providers: [
    {
      provide: 'CONNECTION',
      useValue: connection,
    },
  ],
})
export class AppModule {}
```

```typescript
@Injectable()
export class CatsRepository {
  constructor(@Inject('CONNECTION') connection: Connection) {}
}
```

Best practice: define tokens as constants/symbols in a separate file (e.g. `constants.ts`) and import them.

### useClass (Class providers)

Dynamically determine the class a token resolves to (e.g. environment-specific implementations). The token stays `ConfigService`; the concrete class differs.

```typescript
const configServiceProvider = {
  provide: ConfigService,
  useClass:
    process.env.NODE_ENV === 'development'
      ? DevelopmentConfigService
      : ProductionConfigService,
};

@Module({
  providers: [configServiceProvider],
})
export class AppModule {}
```

### useFactory (Factory providers)

Create providers dynamically from a factory's return value. The factory may inject other providers via `inject` — positionally mapped to the factory args. Injected deps may be marked optional with `{ token, optional: true }`, which can resolve to `undefined`.

```typescript
const connectionProvider = {
  provide: 'CONNECTION',
  useFactory: (optionsProvider: MyOptionsProvider, optionalProvider?: string) => {
    const options = optionsProvider.get();
    return new DatabaseConnection(options);
  },
  inject: [MyOptionsProvider, { token: 'SomeOptionalProvider', optional: true }],
  //       \______________/             \__________________/
  //        This provider                The provider with this token
  //        is mandatory.                can resolve to `undefined`.
};

@Module({
  providers: [
    connectionProvider,
    MyOptionsProvider, // class-based provider
    // { provide: 'SomeOptionalProvider', useValue: 'anything' },
  ],
})
export class AppModule {}
```

### useExisting (Alias providers)

Create an alias so two tokens resolve to the **same singleton instance**. Below, `'AliasedLoggerService'` aliases `LoggerService`; both (in SINGLETON scope) yield the identical instance.

```typescript
@Injectable()
class LoggerService {
  /* implementation details */
}

const loggerAliasProvider = {
  provide: 'AliasedLoggerService',
  useExisting: LoggerService,
};

@Module({
  providers: [LoggerService, loggerAliasProvider],
})
export class AppModule {}
```

### Non-service-based providers

A provider can supply any value, not only services — e.g. an environment-dependent config object:

```typescript
const configFactory = {
  provide: 'CONFIG',
  useFactory: () => {
    return process.env.NODE_ENV === 'development' ? devConfig : prodConfig;
  },
};

@Module({
  providers: [configFactory],
})
export class AppModule {}
```

### Exporting custom providers

A custom provider is scoped to its declaring module. Export it by token or by the full provider object.

```typescript
const connectionFactory = {
  provide: 'CONNECTION',
  useFactory: (optionsProvider: OptionsProvider) => {
    const options = optionsProvider.get();
    return new DatabaseConnection(options);
  },
  inject: [OptionsProvider],
};

@Module({
  providers: [connectionFactory],
  exports: ['CONNECTION'],          // by token
  // exports: [connectionFactory],  // or by full provider object
})
export class AppModule {}
```

## Async Providers

Delay app startup until async tasks finish (e.g. a DB connection). Use `async/await` with `useFactory`: the factory returns a `Promise`; Nest awaits its resolution before instantiating any dependent class.

```typescript
{
  provide: 'ASYNC_CONNECTION',
  useFactory: async () => {
    const connection = await createConnection(options);
    return connection;
  },
}
```

Async providers are injected by token like any other: `@Inject('ASYNC_CONNECTION')`. (See the TypeORM recipe for a fuller example.)

## Dynamic Modules

Static module binding fixes everything at declaration; a **dynamic module** exposes a static method returning a `DynamicModule`, letting the consuming module customize it at import time (plugin/config pattern).

A `DynamicModule` has the same shape as `@Module()` metadata plus one **required** `module` property (the host module class). All other properties are optional.

End-goal — consuming module passes options:

```typescript
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from './config/config.module';

@Module({
  imports: [ConfigModule.register({ folder: './config' })],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

Minimal dynamic module (`DynamicModule` imported from `@nestjs/common`):

```typescript
import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from './config.service';

@Module({})
export class ConfigModule {
  static register(): DynamicModule {
    return {
      module: ConfigModule,
      providers: [ConfigService],
      exports: [ConfigService],
    };
  }
}
```

`imports` can take either a module class or a function returning a dynamic module. A dynamic module may itself declare `imports`.

### Passing options via DI

Bind the `options` object as a provider so the module's services can inject it:

```typescript
import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from './config.service';

@Module({})
export class ConfigModule {
  static register(options: Record<string, any>): DynamicModule {
    return {
      module: ConfigModule,
      providers: [
        {
          provide: 'CONFIG_OPTIONS',
          useValue: options,
        },
        ConfigService,
      ],
      exports: [ConfigService],
    };
  }
}
```

Inject the options with `@Inject()` (non-class token):

```typescript
@Injectable()
export class ConfigService {
  private readonly envConfig: EnvConfig;

  constructor(@Inject('CONFIG_OPTIONS') private options: Record<string, any>) {
    const filePath = `${process.env.NODE_ENV || 'development'}.env`;
    const envFile = path.resolve(__dirname, '../../', options.folder, filePath);
    this.envConfig = dotenv.parse(fs.readFileSync(envFile));
  }

  get(key: string): string {
    return this.envConfig[key];
  }
}
```

Best practice: declare the token as a constant in a separate file: `export const CONFIG_OPTIONS = 'CONFIG_OPTIONS';`

### register / forRoot / forFeature conventions

No hard rule, but `@nestjs/` packages follow these conventions:

- **`register`** — configure a dynamic module with config used only by the calling module; can differ per import (e.g. `HttpModule.register({ baseUrl: 'someUrl' })`).
- **`forRoot`** — configure once and reuse everywhere (e.g. `TypeOrmModule.forRoot()`, `GraphQLModule.forRoot()`).
- **`forFeature`** — reuse `forRoot`'s config but adjust for a specific caller (e.g. which repository / logger context).

Each usually has an async counterpart — `registerAsync`, `forRootAsync`, `forFeatureAsync` — that use Nest DI for configuration too.

### ConfigurableModuleBuilder

Automates the boilerplate of configurable dynamic modules exposing async methods. Define an options interface, then build the definition in a dedicated `*.module-definition.ts` file.

```typescript
export interface ConfigModuleOptions {
  folder: string;
}
```

```typescript
// config.module-definition.ts
import { ConfigurableModuleBuilder } from '@nestjs/common';
import { ConfigModuleOptions } from './interfaces/config-module-options.interface';

export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<ConfigModuleOptions>().build();
```

Extend the generated class — this provides both `register` and `registerAsync`:

```typescript
import { Module } from '@nestjs/common';
import { ConfigService } from './config.service';
import { ConfigurableModuleClass } from './config.module-definition';

@Module({
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule extends ConfigurableModuleClass {}
```

Consume synchronously or asynchronously:

```typescript
@Module({
  imports: [
    ConfigModule.register({ folder: './config' }),
    // or:
    // ConfigModule.registerAsync({
    //   useFactory: () => ({ folder: './config' }),
    //   inject: [...any extra dependencies...]
    // }),
  ],
})
export class AppModule {}
```

`registerAsync` accepts (the three resolution options are **mutually exclusive**):

```typescript
{
  useClass?: Type<ConfigurableModuleOptionsFactory<ModuleOptions, FactoryClassMethodKey>>;
  useFactory?: (...args: any[]) => Promise<ModuleOptions> | ModuleOptions;
  inject?: FactoryProvider['inject'];
  useExisting?: Type<ConfigurableModuleOptionsFactory<ModuleOptions, FactoryClassMethodKey>>;
}
```

- `useFactory` — returns the config object (sync or async); inject deps via `inject` (order must match params).
- `useClass` — a class instantiated as a provider; must implement a `create()` method returning the config.
- `useExisting` — like `useClass` but reuses an already-registered provider.

Inject the generated options token in services:

```typescript
@Injectable()
export class ConfigService {
  constructor(@Inject(MODULE_OPTIONS_TOKEN) private options: ConfigModuleOptions) { ... }
}
```

#### Custom method key (forRoot instead of register)

```typescript
export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<ConfigModuleOptions>()
    .setClassMethodName('forRoot')
    .build();
```

Generates `forRoot` / `forRootAsync` instead of `register` / `registerAsync`.

#### Custom options factory method name

By default `useClass`/`useExisting` factories must expose `create()`. Override with `setFactoryMethodName`:

```typescript
export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<ConfigModuleOptions>()
    .setFactoryMethodName('createConfigOptions')
    .build();
```

The supplied class must then implement `createConfigOptions()`.

#### Extra options (e.g. isGlobal)

`setExtras` adds options that influence the `DynamicModule` definition (like `global`) but are **excluded** from `MODULE_OPTIONS_TOKEN`:

```typescript
export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<ConfigModuleOptions>()
    .setExtras(
      {
        isGlobal: true,
      },
      (definition, extras) => ({
        ...definition,
        global: extras.isGlobal,
      }),
    )
    .build();
```

First arg = defaults for the extra properties; second = a function receiving the auto-generated `definition` and the `extras`, returning a modified definition. Consumers may then pass `isGlobal`, but `ConfigService`'s injected options will not contain it.

#### Extending auto-generated methods

```typescript
import { Module } from '@nestjs/common';
import { ConfigService } from './config.service';
import {
  ConfigurableModuleClass,
  ASYNC_OPTIONS_TYPE,
  OPTIONS_TYPE,
} from './config.module-definition';

@Module({
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule extends ConfigurableModuleClass {
  static register(options: typeof OPTIONS_TYPE): DynamicModule {
    return {
      // your custom logic here
      ...super.register(options),
    };
  }

  static registerAsync(options: typeof ASYNC_OPTIONS_TYPE): DynamicModule {
    return {
      // your custom logic here
      ...super.registerAsync(options),
    };
  }
}
```

Export the helper types from the definition file:

```typescript
export const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<ConfigModuleOptions>().build();
```

## Injection Scopes

In Nest almost everything is shared across requests (singletons are safe — Node is not request-per-thread). Use scopes only for edge cases like per-request caching, request tracking, or multi-tenancy.

| Scope | Behavior |
|-------|----------|
| `DEFAULT` | One shared instance for the whole app; lifetime tied to the app lifecycle; instantiated at bootstrap. Default. |
| `REQUEST` | A new instance per incoming request; garbage-collected after the request completes. |
| `TRANSIENT` | Not shared — each consumer that injects it gets a new dedicated instance. |

> Singleton scope is recommended for most cases (instances cached, initialized once at startup).

### Usage

```typescript
import { Injectable, Scope } from '@nestjs/common';

@Injectable({ scope: Scope.REQUEST })
export class CatsService {}
```

Custom provider long-hand form:

```typescript
{
  provide: 'CACHE_MANAGER',
  useClass: CacheManager,
  scope: Scope.TRANSIENT,
}
```

`Scope` is imported from `@nestjs/common`. Singleton is default; declare explicitly with `Scope.DEFAULT`.

> WebSocket Gateways must be singletons (they encapsulate a real socket) — do not make them request-scoped. Same applies to Passport strategies and Cron controllers.

### Controller scope

Applies to all handlers in the controller:

```typescript
@Controller({
  path: 'cats',
  scope: Scope.REQUEST,
})
export class CatsController {}
```

### Scope hierarchy

`REQUEST` scope **bubbles up** the injection chain. Given `CatsController <- CatsService <- CatsRepository`, if `CatsService` is request-scoped, `CatsController` also becomes request-scoped; `CatsRepository` (no request-scoped dependency) stays singleton.

`TRANSIENT` does **not** bubble: a singleton injecting a transient provider gets a fresh instance but stays singleton itself. To propagate, mark the consumer `TRANSIENT` explicitly too.

### Request provider — @Inject(REQUEST)

Inject the original request object via the `REQUEST` token (inherently request-scoped — specifying the scope is unnecessary and ignored):

```typescript
import { Injectable, Scope, Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

@Injectable({ scope: Scope.REQUEST })
export class CatsService {
  constructor(@Inject(REQUEST) private request: Request) {}
}
```

For GraphQL, inject `CONTEXT` instead (configure the `context` to contain `request`):

```typescript
import { Injectable, Scope, Inject } from '@nestjs/common';
import { CONTEXT } from '@nestjs/graphql';

@Injectable({ scope: Scope.REQUEST })
export class CatsService {
  constructor(@Inject(CONTEXT) private context) {}
}
```

### Inquirer provider

Inject `INQUIRER` (from `@nestjs/core`) to get the class that constructed a (typically transient) provider — useful for logging/metrics:

```typescript
import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';

@Injectable({ scope: Scope.TRANSIENT })
export class HelloService {
  constructor(@Inject(INQUIRER) private parentClass: object) {}

  sayHello(message: string) {
    console.log(`${this.parentClass?.constructor?.name}: ${message}`);
  }
}
```

### Performance

Request-scoped providers slow the app: Nest must create an instance (and everything that bubbled up to request scope) on **every request**, hurting latency/benchmarks. Prefer singleton. A well-designed app using request scope should add no more than ~5% latency.

### Durable providers

Having any request-scoped provider in a controller's chain makes the controller request-scoped — for 30k parallel requests, 30k ephemeral controller instances. For multi-tenant apps keyed by a header/token, **durable providers** let you have N DI sub-trees (one per tenant) instead of one per request.

Register a `ContextIdStrategy` that groups requests:

```typescript
import {
  HostComponentInfo,
  ContextId,
  ContextIdFactory,
  ContextIdStrategy,
} from '@nestjs/core';
import { Request } from 'express';

const tenants = new Map<string, ContextId>();

export class AggregateByTenantContextIdStrategy implements ContextIdStrategy {
  attach(contextId: ContextId, request: Request) {
    const tenantId = request.headers['x-tenant-id'] as string;
    let tenantSubTreeId: ContextId;

    if (tenants.has(tenantId)) {
      tenantSubTreeId = tenants.get(tenantId);
    } else {
      tenantSubTreeId = ContextIdFactory.create();
      tenants.set(tenantId, tenantSubTreeId);
    }

    // If tree is not durable, return the original "contextId" object
    return (info: HostComponentInfo) =>
      info.isTreeDurable ? tenantSubTreeId : contextId;
  }
}
```

To also register a payload (injected via `REQUEST`/`CONTEXT`) for the durable tree, return `{ resolve, payload }` instead of a function:

```typescript
return {
  resolve: (info: HostComponentInfo) =>
    info.isTreeDurable ? tenantSubTreeId : contextId,
  payload: { tenantId },
};
```

Apply the strategy before any request hits the app (e.g. in `main.ts`):

```typescript
ContextIdFactory.apply(new AggregateByTenantContextIdStrategy());
```

Mark a provider durable (durability also bubbles up the chain) — set `durable: true` and `Scope.REQUEST`:

```typescript
import { Injectable, Scope } from '@nestjs/common';

@Injectable({ scope: Scope.REQUEST, durable: true })
export class CatsService {}
```

Custom provider form: `{ provide: 'foobar', useFactory: () => {...}, scope: Scope.REQUEST, durable: true }`.

## Circular Dependency

Occurs when two classes (or two modules) depend on each other. Resolve between providers via `forwardRef()` or `ModuleRef`; between modules via `forwardRef()`.

> Barrel files (`index.ts`) can cause circular dependencies — avoid them for module/provider classes within the same directory.

### Forward reference (providers)

Both sides use `@Inject()` + `forwardRef()` (from `@nestjs/common`):

```typescript
// cats.service.ts
@Injectable()
export class CatsService {
  constructor(
    @Inject(forwardRef(() => CommonService))
    private commonService: CommonService,
  ) {}
}
```

```typescript
// common.service.ts
@Injectable()
export class CommonService {
  constructor(
    @Inject(forwardRef(() => CatsService))
    private catsService: CatsService,
  ) {}
}
```

> Instantiation order is indeterminate — don't depend on which constructor runs first. Circular deps on `Scope.REQUEST` providers can yield undefined dependencies.

### ModuleRef alternative

Instead of `forwardRef()`, refactor and use `ModuleRef` to fetch one side of the relationship at runtime (see ModuleRef section).

### Module forward reference

Both modules wrap each other with `forwardRef()`:

```typescript
// common.module.ts
@Module({
  imports: [forwardRef(() => CatsModule)],
})
export class CommonModule {}
```

```typescript
// cats.module.ts
@Module({
  imports: [forwardRef(() => CommonModule)],
})
export class CatsModule {}
```

## ModuleRef

`ModuleRef` (from `@nestjs/core`) navigates the provider list and dynamically instantiates static and scoped providers. Inject it normally:

```typescript
@Injectable()
export class CatsService {
  constructor(private moduleRef: ModuleRef) {}
}
```

### get() — static instances

Returns a provider/controller/injectable already instantiated in the **current module** by token. Throws if not found.

```typescript
@Injectable()
export class CatsService implements OnModuleInit {
  private service: Service;
  constructor(private moduleRef: ModuleRef) {}

  onModuleInit() {
    this.service = this.moduleRef.get(Service);
  }
}
```

> `get()` cannot retrieve scoped (transient/request) providers — use `resolve()`.

Search the global context (provider from another module) with `{ strict: false }`:

```typescript
this.moduleRef.get(Service, { strict: false });
```

### resolve() — scoped providers

Returns a `Promise` of a **new** instance from its own DI sub-tree (each sub-tree has a unique context id). Multiple `resolve()` calls give different instances:

```typescript
async onModuleInit() {
  const transientServices = await Promise.all([
    this.moduleRef.resolve(TransientService),
    this.moduleRef.resolve(TransientService),
  ]);
  console.log(transientServices[0] === transientServices[1]); // false
}
```

Pass a shared context id (from `ContextIdFactory.create()`, imported from `@nestjs/core`) to get the **same** instance across calls:

```typescript
async onModuleInit() {
  const contextId = ContextIdFactory.create();
  const transientServices = await Promise.all([
    this.moduleRef.resolve(TransientService, contextId),
    this.moduleRef.resolve(TransientService, contextId),
  ]);
  console.log(transientServices[0] === transientServices[1]); // true
}
```

### Registering REQUEST for a manual sub-tree

A manually created context id has `REQUEST` undefined. Register a request object for it:

```typescript
const contextId = ContextIdFactory.create();
this.moduleRef.registerRequestByContextId(/* YOUR_REQUEST_OBJECT */, contextId);
```

### Getting the current sub-tree (within a request)

To resolve a request-scoped provider inside an existing request context, derive the context id from the injected request instead of creating a new one:

```typescript
@Injectable()
export class CatsService {
  constructor(@Inject(REQUEST) private request: Record<string, unknown>) {}
}
```

```typescript
const contextId = ContextIdFactory.getByRequest(this.request);
const catsRepository = await this.moduleRef.resolve(CatsRepository, contextId);
```

### create() — instantiate an unregistered class

Instantiates a class that was **not** registered as a provider (Nest resolves its constructor deps). Returns a `Promise`.

```typescript
@Injectable()
export class CatsService implements OnModuleInit {
  private catsFactory: CatsFactory;
  constructor(private moduleRef: ModuleRef) {}

  async onModuleInit() {
    this.catsFactory = await this.moduleRef.create(CatsFactory);
  }
}
```

## Lazy-Loading Modules

Modules are eagerly loaded by default. Lazy loading reduces cold-start latency (serverless) by loading only what a specific invocation needs.

> Lifecycle hook methods are **not** invoked in lazy-loaded modules/services.

Inject `LazyModuleLoader` (from `@nestjs/core`), or get it from the app: `const lazyModuleLoader = app.get(LazyModuleLoader);`.

```typescript
@Injectable()
export class CatsService {
  constructor(private lazyModuleLoader: LazyModuleLoader) {}
}
```

Load a module on demand (dynamic `import()` keeps it out of the initial bundle):

```typescript
const { LazyModule } = await import('./lazy.module');
const moduleRef = await this.lazyModuleLoader.load(() => LazyModule);
```

`load()` returns a `ModuleRef`; retrieve providers from it:

```typescript
const { LazyModule } = await import('./lazy.module');
const moduleRef = await this.lazyModuleLoader.load(() => LazyModule);

const { LazyService } = await import('./lazy.service');
const lazyService = moduleRef.get(LazyService);
```

Key points:
- Lazy modules are **cached** after the first `load()` — subsequent loads are near-instant and return the cached instance. They share the same modules graph as eager modules.
- The lazy file exports a **regular** Nest module (no special changes).
- Lazy modules **cannot** be global modules, and global enhancers won't apply to them.
- **Controllers, resolvers, gateways, and middleware cannot be lazy-loaded** — routing/topics/schema must be known at bootstrap (e.g. Fastify can't add routes after ready; microservice transports must subscribe before connecting; code-first GraphQL needs all classes upfront).
- With Webpack, set `compilerOptions.module: "esnext"` and `compilerOptions.moduleResolution: "node"` in `tsconfig.json` for code splitting.

## Execution Context

Two utilities let guards/filters/interceptors work across HTTP, RPC (microservices), and WebSockets: `ArgumentsHost` and `ExecutionContext` (which extends it).

### ArgumentsHost

Abstraction over a handler's arguments. For Express HTTP it wraps `[request, response, next]`; for GraphQL `[root, args, context, info]`. Provided e.g. as `host` to an exception filter's `catch()`.

Detect the current context type:

```typescript
if (host.getType() === 'http') {
  // regular HTTP (REST)
} else if (host.getType() === 'rpc') {
  // Microservice
} else if (host.getType<GqlContextType>() === 'graphql') {
  // GraphQL (GqlContextType from @nestjs/graphql)
}
```

Generic argument access (couples to context — avoid when possible):

```typescript
const [req, res, next] = host.getArgs();
const request = host.getArgByIndex(0);
const response = host.getArgByIndex(1);
```

Context-switch helpers (preferred):

```typescript
switchToRpc(): RpcArgumentsHost;
switchToHttp(): HttpArgumentsHost;
switchToWs(): WsArgumentsHost;
```

HTTP:

```typescript
const ctx = host.switchToHttp();
const request = ctx.getRequest<Request>();
const response = ctx.getResponse<Response>();
```

WS / RPC interfaces:

```typescript
export interface WsArgumentsHost {
  getData<T>(): T;
  getClient<T>(): T;
}

export interface RpcArgumentsHost {
  getData<T>(): T;
  getContext<T>(): T;
}
```

### ExecutionContext

Extends `ArgumentsHost`; provided to guards' `canActivate()` and interceptors' `intercept()`. Adds:

```typescript
export interface ExecutionContext extends ArgumentsHost {
  getClass<T>(): Type<T>;   // the controller CLASS the handler belongs to
  getHandler(): Function;   // the handler (method) about to be invoked
}
```

```typescript
const methodKey = ctx.getHandler().name; // "create"
const className = ctx.getClass().name;   // "CatsController"
```

### Reflection and metadata

Create strongly-typed decorators with `Reflector.createDecorator` (from `@nestjs/core`):

```typescript
// roles.decorator.ts
import { Reflector } from '@nestjs/core';

export const Roles = Reflector.createDecorator<string[]>();
```

```typescript
@Post()
@Roles(['admin'])
async create(@Body() createCatDto: CreateCatDto) {
  this.catsService.create(createCatDto);
}
```

Read it in a guard via injected `Reflector`:

```typescript
@Injectable()
export class RolesGuard {
  constructor(private reflector: Reflector) {}
}
```

```typescript
const roles = this.reflector.get(Roles, context.getHandler()); // handler-level
const roles = this.reflector.get(Roles, context.getClass());   // controller-level
```

Merge handler + controller metadata:

```typescript
// override: handler value wins
const roles = this.reflector.getAllAndOverride(Roles, [context.getHandler(), context.getClass()]);
// merge arrays/objects from both
const roles = this.reflector.getAllAndMerge(Roles, [context.getHandler(), context.getClass()]);
```

Low-level alternative with `@SetMetadata` (from `@nestjs/common`):

```typescript
import { SetMetadata } from '@nestjs/common';
export const Roles = (...roles: string[]) => SetMetadata('roles', roles);
```

```typescript
const roles = this.reflector.get<string[]>('roles', context.getHandler());
```

## Lifecycle Events

Three phases — **initializing**, **running**, **terminating**. Hooks run on modules, providers, and controllers.

| Hook method | Triggered when |
|-------------|----------------|
| `onModuleInit()` | Once the host module's dependencies have been resolved. |
| `onApplicationBootstrap()` | Once all modules initialized, before listening for connections. |
| `onModuleDestroy()` * | After a termination signal (e.g. `SIGTERM`) is received. |
| `beforeApplicationShutdown()` * | After all `onModuleDestroy()` handlers complete (resolved/rejected); then connections close (`app.close()`). |
| `onApplicationShutdown()` * | After connections close (`app.close()` resolves). |

- `onModuleInit`/`onApplicationBootstrap` only fire if you call `app.init()` or `app.listen()`.
- \* Shutdown hooks only fire on `app.close()` or on a system signal **with** `enableShutdownHooks()` enabled.
- Hooks are **not** triggered for request-scoped classes (unpredictable lifespan).
- Execution order of init hooks follows module import order, awaiting the previous hook.

Implement the matching interface (from `@nestjs/common`):

```typescript
import { Injectable, OnModuleInit } from '@nestjs/common';

@Injectable()
export class UsersService implements OnModuleInit {
  onModuleInit() {
    console.log(`The module has been initialized.`);
  }
}
```

Interfaces: `OnModuleInit`, `OnApplicationBootstrap`, `OnModuleDestroy`, `BeforeApplicationShutdown`, `OnApplicationShutdown`.

### Asynchronous initialization

`OnModuleInit` and `OnApplicationBootstrap` may return a `Promise` / be `async`; Nest awaits it before proceeding:

```typescript
async onModuleInit(): Promise<void> {
  await this.fetch();
}
```

### Application shutdown — enableShutdownHooks

Shutdown listeners consume resources and are **disabled by default**. Enable them at bootstrap:

```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Starts listening for shutdown hooks
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

The received signal is passed as the first parameter; Nest awaits any returned promise before continuing the sequence:

```typescript
@Injectable()
class UsersService implements OnApplicationShutdown {
  onApplicationShutdown(signal: string) {
    console.log(signal); // e.g. "SIGINT"
  }
}
```

Notes:
- Windows support is limited (`SIGINT`/`SIGBREAK`/partial `SIGHUP`; `SIGTERM` never works there).
- `enableShutdownHooks` consumes memory by adding listeners — avoid when running many Nest apps in one Node process (e.g. parallel Jest tests).
- `app.close()` triggers `onModuleDestroy`/`onApplicationShutdown` but does **not** terminate the Node process (intervals/background tasks keep it alive).

## Platform Agnosticism

Nest is platform-agnostic: build reusable logic that runs across underlying HTTP frameworks (Express, Fastify) and across application types (HTTP, microservices with different transports, WebSockets).

- Building blocks (guards, interceptors, pipes, filters) built on `ExecutionContext`/`ArgumentsHost` run across transport layers unchanged.
- A dedicated GraphQL module can replace the REST API layer interchangeably.
- The application context feature supports non-server apps (CRON jobs, CLI). "Build once, use everywhere."

## Testing

Install: `npm i --save-dev @nestjs/testing`. Jest + Supertest integrate out-of-the-box; Nest stays tooling-agnostic. Test files use `.spec`/`.test` (unit) and `.e2e-spec` (e2e) suffixes; keep unit tests near the classes, e2e tests in `test/`.

### Isolated unit testing (no DI)

Manually instantiate — framework-independent:

```typescript
import { CatsController } from './cats.controller';
import { CatsService } from './cats.service';

describe('CatsController', () => {
  let catsController: CatsController;
  let catsService: CatsService;

  beforeEach(() => {
    catsService = new CatsService();
    catsController = new CatsController(catsService);
  });

  describe('findAll', () => {
    it('should return an array of cats', async () => {
      const result = ['test'];
      jest.spyOn(catsService, 'findAll').mockImplementation(() => result);

      expect(await catsController.findAll()).toBe(result);
    });
  });
});
```

### Test.createTestingModule + compile()

`Test.createTestingModule(metadata)` takes the same metadata as `@Module()`. `compile()` is **async** (bootstraps the module + deps) and returns a `TestingModule`. Retrieve **static** instances with `get()`.

```typescript
import { Test } from '@nestjs/testing';
import { CatsController } from './cats.controller';
import { CatsService } from './cats.service';

describe('CatsController', () => {
  let catsController: CatsController;
  let catsService: CatsService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CatsController],
      providers: [CatsService],
    }).compile();

    catsService = moduleRef.get(CatsService);
    catsController = moduleRef.get(CatsController);
  });

  describe('findAll', () => {
    it('should return an array of cats', async () => {
      const result = ['test'];
      jest.spyOn(catsService, 'findAll').mockImplementation(() => result);

      expect(await catsController.findAll()).toBe(result);
    });
  });
});
```

`TestingModule` extends `ModuleRef`, so scoped (transient/request) providers use `resolve()` (each call → a new instance from its own sub-tree):

```typescript
const moduleRef = await Test.createTestingModule({
  controllers: [CatsController],
  providers: [CatsService],
}).compile();

catsService = await moduleRef.resolve(CatsService);
```

### Mocking deps with custom providers

Override a production provider with a mock (works for unit tests too) — either via the custom-provider syntax in metadata, or via the override methods (below).

```typescript
const moduleRef = await Test.createTestingModule({
  controllers: [CatsController],
  providers: [
    { provide: CatsService, useValue: { findAll: jest.fn().mockResolvedValue([]) } },
  ],
}).compile();
```

For non-class tokens, mock via `{ provide: 'CONNECTION', useValue: mockConn }`.

### Auto mocking — useMocker()

Apply a mock factory for all missing dependencies. The factory receives the token and returns a mock:

```typescript
import { ModuleMocker, MockMetadata } from 'jest-mock';

const moduleMocker = new ModuleMocker(global);

describe('CatsController', () => {
  let controller: CatsController;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CatsController],
    })
      .useMocker((token) => {
        const results = ['test1', 'test2'];
        if (token === CatsService) {
          return { findAll: jest.fn().mockResolvedValue(results) };
        }
        if (typeof token === 'function') {
          const mockMetadata = moduleMocker.getMetadata(token) as MockMetadata<any, any>;
          const Mock = moduleMocker.generateFromMetadata(mockMetadata) as ObjectConstructor;
          return new Mock();
        }
      })
      .compile();

    controller = moduleRef.get(CatsController);
  });
});
```

Mocks can be retrieved with `moduleRef.get(CatsService)`. A general factory like `createMock` from `@golevelup/ts-jest` may be passed directly. `REQUEST` and `INQUIRER` cannot be auto-mocked (pre-defined) but can be overridden.

### End-to-end testing (Supertest + INestApplication)

Use `createNestApplication()` for a full runtime, `await app.init()` before requests, and Supertest's `request(app.getHttpServer())`:

```typescript
import * as request from 'supertest';
import { Test } from '@nestjs/testing';
import { CatsModule } from '../../src/cats/cats.module';
import { CatsService } from '../../src/cats/cats.service';
import { INestApplication } from '@nestjs/common';

describe('Cats', () => {
  let app: INestApplication;
  let catsService = { findAll: () => ['test'] };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CatsModule],
    })
      .overrideProvider(CatsService)
      .useValue(catsService)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  it(`/GET cats`, () => {
    return request(app.getHttpServer())
      .get('/cats')
      .expect(200)
      .expect({
        data: catsService.findAll(),
      });
  });

  afterAll(async () => {
    await app.close();
  });
});
```

> After `compile()` only, `HttpAdapterHost#httpAdapter` is undefined (no server yet). Use `createNestApplication()` if the test needs the adapter.

Fastify variant uses `inject()` and must await readiness:

```typescript
let app: NestFastifyApplication;

beforeAll(async () => {
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

it(`/GET cats`, () => {
  return app
    .inject({ method: 'GET', url: '/cats' })
    .then((result) => {
      expect(result.statusCode).toEqual(200);
      expect(result.payload).toEqual(/* expectedPayload */);
    });
});
```

### Override methods (fluent API)

`overrideProvider()`, `overrideGuard()`, `overrideInterceptor()`, `overrideFilter()`, `overridePipe()` each return an object with `useClass`, `useValue`, `useFactory`. `overrideModule()` returns `useModule()`. Each returns the `TestingModule` for chaining; finish with `compile()`.

```typescript
const moduleRef = await Test.createTestingModule({
  imports: [AppModule],
})
  .overrideModule(CatsModule)
  .useModule(AlternateCatsModule)
  .compile();
```

`setLogger(loggerService)` customizes test logging (default: only errors logged). Compiled-module methods: `createNestApplication()`, `createNestMicroservice()`, `get()` (static), `resolve()` (scoped), `select()` (navigate the module graph, with `strict: true`).

### Overriding globally-registered enhancers

A global guard registered via `APP_GUARD` + `useClass` is a "multi"-provider and **cannot** be overridden directly. Switch to `useExisting` referencing the registered class:

```typescript
providers: [
  {
    provide: APP_GUARD,
    useExisting: JwtAuthGuard, // was useClass
  },
  JwtAuthGuard,
],
```

Now it can be overridden:

```typescript
const moduleRef = await Test.createTestingModule({
  imports: [AppModule],
})
  .overrideProvider(JwtAuthGuard)
  .useClass(MockAuthGuard)
  .compile();
```

### Testing request-scoped instances

Force a known context id so you can retrieve the per-request sub-tree. Spy on `ContextIdFactory.getByRequest`:

```typescript
const contextId = ContextIdFactory.create();
jest
  .spyOn(ContextIdFactory, 'getByRequest')
  .mockImplementation(() => contextId);
```

Then resolve with that id:

```typescript
catsService = await moduleRef.resolve(CatsService, contextId);
```
