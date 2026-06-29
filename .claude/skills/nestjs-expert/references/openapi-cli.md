# NestJS OpenAPI, CLI & Tooling Reference

Targets NestJS v11 + TypeScript. Covers `@nestjs/swagger` (OpenAPI), the Nest CLI, webpack hot reload, and lifecycle/graceful-shutdown hooks.

## OpenAPI / Swagger setup

Install: `pnpm add @nestjs/swagger` (the package bundles Swagger UI; no separate `swagger-ui-express`/`fastify-swagger` needed for v11).

Bootstrap in `main.ts` with `DocumentBuilder` + `SwaggerModule`:

```typescript
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = new DocumentBuilder()
    .setTitle('Cats example')
    .setDescription('The cats API description')
    .setVersion('1.0')
    .addTag('cats')
    .build();
  const documentFactory = () => SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, documentFactory);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

- `SwaggerModule.createDocument(app, config, options?)` builds a serializable OpenAPI document (reflects all routes). Passing a **factory** (`() => createDocument(...)`) defers generation until the document is requested, saving init time.
- `SwaggerModule.setup(path, app, documentFactory, options?)` mounts the Swagger UI. Args: (1) UI mount path, (2) app instance, (3) document/factory, (4) optional `SwaggerCustomOptions`.
- UI served at `http://localhost:3000/api`; JSON at `/api-json`, YAML at `/api-yaml`.

You can save the document to disk instead of/in addition to serving it (it is a plain serializable object conforming to the OpenAPI spec).

### DocumentBuilder methods

`setTitle`, `setDescription`, `setVersion`, `setOpenAPIVersion('3.2.0')`, `addTag(name, description?, externalDocs?, options?)`, `addServer`, `addGlobalResponse({ status, description })`, security helpers `addSecurity`, `addBasicAuth`, `addBearerAuth`, `addOAuth2`, `addCookieAuth`. Terminate the chain with `.build()`.

### Document options (`SwaggerDocumentOptions`)

Third arg to `createDocument`. Key fields:

```typescript
{
  include?: Function[];          // modules to include
  extraModels?: Function[];      // extra models to inspect (see Extra models)
  ignoreGlobalPrefix?: boolean;  // ignore setGlobalPrefix()
  deepScanRoutes?: boolean;      // also scan routes of modules imported by included modules
  operationIdFactory?: OperationIdFactory; // default: controllerKey_methodKey_version
  linkNameFactory?: (controllerKey, methodKey, fieldKey) => string;
  autoTagControllers?: boolean;  // default true; uses controller name minus "Controller" suffix
}
```

To get clean operation ids like `createUser` instead of `UsersController_createUser`:

```typescript
const options: SwaggerDocumentOptions = {
  operationIdFactory: (controllerKey: string, methodKey: string) => methodKey,
};
const documentFactory = () => SwaggerModule.createDocument(app, config, options);
```

Set `autoTagControllers: false` to require explicit `@ApiTags()`.

### Setup options (`SwaggerCustomOptions`)

Fourth arg to `setup`. `ui` and `raw` are independent: disabling one does not disable the other.

- `useGlobalPrefix?: boolean` — prefix Swagger paths with the app's global prefix (default `false`).
- `ui?: boolean` — serve Swagger UI (default `true`); `swaggerUiEnabled` is the deprecated alias.
- `raw?: boolean | Array<'json' | 'yaml'>` — serve raw definitions (default `true`); `raw: ['json']` serves JSON only; `raw: []` serves none.
- `jsonDocumentUrl` / `yamlDocumentUrl` — custom definition paths (defaults `<path>-json` / `<path>-yaml`).
- `patchDocumentOnRequest(req, res, document) => OpenAPIObject` — mutate the document per request before serving.
- `explorer?: boolean`, `swaggerOptions?: SwaggerUiOptions`, `customCss`, `customCssUrl`, `customJs`, `customJsStr`, `customfavIcon`, `customSiteTitle`, `customSwaggerUiPath`.

Expose JSON on a custom route, or serve definitions without UI:

```typescript
SwaggerModule.setup('swagger', app, documentFactory, { jsonDocumentUrl: 'swagger/json' });

// UI off, JSON definition still served
const options: SwaggerCustomOptions = { ui: false, raw: ['json'] };
SwaggerModule.setup('api', app, options);
```

Fastify + helmet may collide on CSP; configure `contentSecurityPolicy` directives (allow `validator.swagger.io`, `'unsafe-inline'` styles/scripts) or set `contentSecurityPolicy: false`.

## CLI plugin (auto-introspection)

TypeScript reflection cannot tell which properties a class has or whether they are optional. The `@nestjs/swagger` compiler plugin fixes this at compile time so you don't have to hand-write `@ApiProperty()` everywhere. It is **opt-in**.

The plugin automatically: annotates DTO properties with `@ApiProperty` (unless `@ApiHideProperty`); sets `required` from the `?` optional marker; sets `type`/`enum` from the TS type (incl. arrays); sets `default` from initializers; mirrors `class-validator` rules into the schema (when `classValidatorShim: true`); adds a response decorator with status + model to each endpoint; and (when `introspectComments: true`) derives descriptions/examples from JSDoc comments.

Files must end with `.dto.ts` or `.entity.ts` (configurable via `dtoFileNameSuffix`) to be analyzed.

Enable in `nest-cli.json`:

```javascript
{
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "plugins": [
      {
        "name": "@nestjs/swagger",
        "options": {
          "classValidatorShim": false,
          "introspectComments": true,
          "skipAutoHttpCode": true
        }
      }
    ]
  }
}
```

Shorthand (no options): `"plugins": ["@nestjs/swagger"]`.

`PluginOptions` (with defaults):

| Option | Default | Notes |
| --- | --- | --- |
| `dtoFileNameSuffix` | `['.dto.ts', '.entity.ts']` | DTO file suffixes |
| `controllerFileNameSuffix` | `.controller.ts` | Controller file suffixes |
| `classValidatorShim` | `true` | Reuse `class-validator` decorators (e.g. `@Max(10)` → `max: 10`) |
| `dtoKeyOfComment` | `'description'` | Property key for comment text on `ApiProperty` |
| `controllerKeyOfComment` | `'summary'` | Property key for comment text on `ApiOperation` |
| `introspectComments` | `false` | Generate descriptions/examples from comments |
| `skipAutoHttpCode` | `false` | Disable auto `@HttpCode()` injection |
| `esmCompatible` | `false` | Fixes ESM (`"type": "module"`) syntax errors |

With the plugin enabled, a DTO can drop decorators entirely; the plugin derives `@ApiProperty()` from TS types and `class-validator` decorators (runtime validation still requires the validators):

```typescript
export class CreateUserDto {
  email: string;
  password: string;
  roles: RoleEnum[] = [];
  isEnabled?: boolean = true;
}
```

Notes: import mapped-type utilities (`PartialType`, etc.) from `@nestjs/swagger` (not `@nestjs/mapped-types`) so the plugin picks up schemas. Override any generated property by setting it explicitly via `@ApiProperty()`. Delete `/dist` and rebuild after changing plugin options.

Comments introspection example — `@remarks`, `@deprecated`, `@throws {code}` are recognized:

```typescript
/**
 * Create a new cat
 * @remarks This operation allows you to create a new cat.
 * @deprecated
 * @throws {500} Something went wrong.
 * @throws {400} Bad Request.
 */
@Post()
async create(): Promise<Cat> {}
```

For SWC builds, enable type-checking: `nest start -b swc --type-check`. Without the CLI (custom webpack + `ts-loader`), register the transformer:

```javascript
getCustomTransformers: (program: any) => ({
  before: [require('@nestjs/swagger/plugin').before({}, program)]
}),
```

`ts-jest` (e2e) bypasses the CLI compiler, so register the transformer in a small file and reference it under `transform` (`jest@^29`) or `globals.ts-jest.astTransformers.before` (`jest@<29`); for SWC-generated metadata, load it via `await SwaggerModule.loadPluginMetadata(metadata)` before `createDocument`. Clear cache with `npx jest --clearCache` if config changes aren't picked up.

## Documenting DTOs: types, properties, enums

Without the plugin, annotate each property with `@ApiProperty()`; optional ones with `@ApiPropertyOptional()` (shorthand for `@ApiProperty({ required: false })`).

```typescript
import { ApiProperty } from '@nestjs/swagger';

export class CreateCatDto {
  @ApiProperty()
  name: string;

  @ApiProperty({ description: 'The age of a cat', minimum: 1, default: 1 })
  age: number;

  @ApiProperty({ type: Number })
  breed: string;
}
```

`@ApiProperty()` accepts any OpenAPI Schema Object field (`description`, `minimum`, `default`, `type`, `example`, `examples`, `enum`, `enumName`, `isArray`, `oneOf`, `anyOf`, `allOf`, `format`, raw `items`/`properties`, etc.).

### Arrays and circular deps

```typescript
@ApiProperty({ type: [String] })   // or { type: String, isArray: true }
names: string[];

@ApiProperty({ type: () => Node }) // lazy fn for circular dependencies
node: Node;
```

### Generics / interfaces

TS doesn't store metadata about generics/interfaces. Set the type explicitly, e.g. via `@ApiBody`:

```typescript
@ApiBody({ type: [CreateUserDto] })
createBulk(@Body() usersDto: CreateUserDto[]) {}
```

### Enums

```typescript
@ApiProperty({ enum: ['Admin', 'Moderator', 'User'] })
role: UserRole;
```

Or a real TS enum, usable with `@ApiQuery`:

```typescript
export enum UserRole { Admin = 'Admin', Moderator = 'Moderator', User = 'User' }

@ApiQuery({ name: 'role', enum: UserRole })
async filterByRole(@Query('role') role: UserRole = UserRole.User) {}
```

With `isArray: true` the enum renders as multi-select. Pass `enumName` to emit a **reusable** named schema (`$ref`) instead of inlining the enum (avoids duplicated enums in generated clients). Any decorator that accepts `enum` also accepts `enumName`:

```typescript
@ApiProperty({ enum: CatBreed, enumName: 'CatBreed' })
breed: CatBreed;
```

### Examples, raw definitions, oneOf/anyOf/allOf

```typescript
@ApiProperty({ example: 'persian' })
breed: string;

@ApiProperty({ examples: { Persian: { value: 'persian' }, Tabby: { value: 'tabby' } } })
breed2: string;

@ApiProperty({ type: 'array', items: { type: 'array', items: { type: 'number' } } })
coords: number[][];

@ApiProperty({ oneOf: [{ $ref: getSchemaPath(Cat) }, { $ref: getSchemaPath(Dog) }] })
pet: Cat | Dog;
```

`getSchemaPath(Model)` (from `@nestjs/swagger`) returns the `$ref` path. Polymorphic arrays need a raw `items.oneOf` definition; members must be registered as extra models.

### Extra models, schema name/description

```typescript
@ApiExtraModels(ExtraModel)        // register once per model not referenced by a controller
export class CreateCatDto {}

// or via createDocument options: { extraModels: [ExtraModel] }

@ApiSchema({ name: 'CreateCatRequest', description: 'Description of the CreateCatDto schema' })
class CreateCatDto {}              // renames schema + adds description
```

### Mapped types

Import `PartialType`, `PickType`, `OmitType`, `IntersectionType` from `@nestjs/swagger` (see `/openapi/mapped-types`) so the CLI plugin and Swagger pick up the derived schemas.

## Operations (controllers / endpoints)

### Tags, headers, security on controllers

```typescript
@ApiTags('cats')
@ApiBearerAuth()
@ApiHeader({ name: 'X-MyHeader', description: 'Custom header' })
@Controller('cats')
export class CatsController {}
```

OpenAPI 3.2 tag hierarchy must be declared via `DocumentBuilder` (decorator `@ApiTags()` ignores `parent`/`kind`) and requires `setOpenAPIVersion('3.2.0')`:

```typescript
const config = new DocumentBuilder()
  .setOpenAPIVersion('3.2.0')
  .addTag('Animals', 'Everything about animals', undefined, { kind: 'nav' })
  .addTag('Cats', 'Cat operations', undefined, { parent: 'Animals' })
  .build();
```

### Operation summary & responses

`@ApiOperation({ summary, description, deprecated, ... })` documents the method. `@ApiResponse({ status, description, type })` documents a response; many shorthands inherit from it:

```typescript
@Post()
@ApiOperation({ summary: 'Create cat' })
@ApiCreatedResponse({ description: 'The record has been successfully created.', type: Cat })
@ApiForbiddenResponse({ description: 'Forbidden.' })
async create(@Body() dto: CreateCatDto): Promise<Cat> {
  return this.catsService.create(dto);
}
```

Shorthand response decorators include: `@ApiOkResponse`, `@ApiCreatedResponse`, `@ApiAcceptedResponse`, `@ApiNoContentResponse`, `@ApiMovedPermanentlyResponse`, `@ApiFoundResponse`, `@ApiBadRequestResponse`, `@ApiUnauthorizedResponse`, `@ApiNotFoundResponse`, `@ApiForbiddenResponse`, `@ApiMethodNotAllowedResponse`, `@ApiNotAcceptableResponse`, `@ApiRequestTimeoutResponse`, `@ApiConflictResponse`, `@ApiPreconditionFailedResponse`, `@ApiTooManyRequestsResponse`, `@ApiGoneResponse`, `@ApiPayloadTooLargeResponse`, `@ApiUnsupportedMediaTypeResponse`, `@ApiUnprocessableEntityResponse`, `@ApiInternalServerErrorResponse`, `@ApiNotImplementedResponse`, `@ApiBadGatewayResponse`, `@ApiServiceUnavailableResponse`, `@ApiGatewayTimeoutResponse`, `@ApiDefaultResponse`.

`type` references a model class (every property annotated with `@ApiProperty()`). Global responses for all endpoints: `DocumentBuilder().addGlobalResponse({ status: 500, description: 'Internal server error' })`.

### Params, query, body

`@ApiParam({ name, ... })`, `@ApiQuery({ name, enum, isArray, required, ... })`, and `@ApiBody({ type, description, schema })` explicitly document inputs (Swagger otherwise infers from `@Param`/`@Query`/`@Body`). Use `@ApiBody({ schema: {...} })` for raw input schemas. `@ApiExcludeEndpoint()` hides a method; `@ApiExcludeController()` hides a whole controller.

### File upload

```typescript
@UseInterceptors(FileInterceptor('file'))
@ApiConsumes('multipart/form-data')
@ApiBody({ description: 'List of cats', type: FileUploadDto })
uploadFile(@UploadedFile() file: Express.Multer.File) {}

class FileUploadDto {
  @ApiProperty({ type: 'string', format: 'binary' })
  file: any;
}
// multiple: @ApiProperty({ type: 'array', items: { type: 'string', format: 'binary' } }) files: any[];
```

### Extensions

`@ApiExtension('x-foo', { hello: 'world' })` — name must be prefixed `x-`.

### Advanced: generic responses with getSchemaPath + allOf

Wrap a generic envelope (`PaginatedDto<T>`) around any model. Register both with `@ApiExtraModels` and compose with `allOf`:

```typescript
export class PaginatedDto<TData> {
  @ApiProperty() total: number;
  @ApiProperty() limit: number;
  @ApiProperty() offset: number;
  results: TData[]; // raw-defined below
}

export const ApiPaginatedResponse = <TModel extends Type<any>>(model: TModel) =>
  applyDecorators(
    ApiExtraModels(PaginatedDto, model),
    ApiOkResponse({
      schema: {
        title: `PaginatedResponseOf${model.name}`, // disambiguates client generators
        allOf: [
          { $ref: getSchemaPath(PaginatedDto) },
          { properties: { results: { type: 'array', items: { $ref: getSchemaPath(model) } } } },
        ],
      },
    }),
  );

@ApiPaginatedResponse(CatDto)
async findAll(): Promise<PaginatedDto<CatDto>> {}
```

`Type<any>` and `applyDecorators` come from `@nestjs/common`. Models not directly referenced by a controller must be added as extra models (here via the custom decorator).

## Security schemes

Use a security decorator on the controller/method, and register the matching scheme on `DocumentBuilder`. `basic` and `bearer` are built-in.

```typescript
// Bearer (JWT)
@ApiBearerAuth()                         // .addBearerAuth()
// Cookie
@ApiCookieAuth()                         // .addCookieAuth('optional-session-id')
// Basic
@ApiBasicAuth()                          // .addBasicAuth()
// OAuth2
@ApiOAuth2(['pets:write'])               // .addOAuth2()
// Generic / custom
@ApiSecurity('basic')                    // .addSecurity('basic', { type: 'http', scheme: 'basic' })
@Controller('cats')
export class CatsController {}
```

## Decorator reference (application level)

| Decorator | Level |
| --- | --- |
| `@ApiBasicAuth()` | Method / Controller |
| `@ApiBearerAuth()` | Method / Controller |
| `@ApiBody()` | Method |
| `@ApiConsumes()` | Method / Controller |
| `@ApiCookieAuth()` | Method / Controller |
| `@ApiExcludeController()` | Controller |
| `@ApiExcludeEndpoint()` | Method |
| `@ApiExtension()` | Method |
| `@ApiExtraModels()` | Method / Controller |
| `@ApiHeader()` | Method / Controller |
| `@ApiHideProperty()` | Model |
| `@ApiOAuth2()` | Method / Controller |
| `@ApiOperation()` | Method |
| `@ApiParam()` | Method / Controller |
| `@ApiProduces()` | Method / Controller |
| `@ApiSchema()` | Model |
| `@ApiProperty()` | Model |
| `@ApiPropertyOptional()` | Model |
| `@ApiQuery()` | Method / Controller |
| `@ApiResponse()` | Method / Controller |
| `@ApiSecurity()` | Method / Controller |
| `@ApiTags()` | Method / Controller |
| `@ApiCallbacks()` | Method / Controller |

## Nest CLI

`@nestjs/cli` scaffolds, serves, builds, and bundles apps. Install globally `npm i -g @nestjs/cli`, or run ad hoc with `npx @nestjs/cli@latest`. Requires a Node binary with ICU (`node -p process.versions.icu` must not print `undefined`).

Syntax: `nest commandOrAlias requiredArg [optionalArg] [options]`. Missing required args are prompted. `--dry-run`/`-d` previews changes. Use `nest --help` and `nest <command> --help`.

### Commands

| Command | Alias | Description |
| --- | --- | --- |
| `new` | `n` | Scaffold a new standard-mode app |
| `generate` | `g` | Generate/modify files from a schematic |
| `build` | | Compile app/workspace into output folder |
| `start` | | Compile and run app (or default project) |
| `add` | | Import a packaged Nest library, running its install schematic |
| `info` | `i` | Show installed Nest packages + system info |

```bash
nest new my-nest-project      # n; scaffold; --dry-run / -d to preview
cd my-nest-project
npm run start:dev             # watch + reload
```

### Generate (g) schematics

`nest generate <schematic> <name>` scaffolds and wires components into the nearest module. Common schematics: `module` (`mo`), `controller` (`co`), `service` (`s`), `resource` (`res`, CRUD generator that scaffolds module + controller + service + DTOs + entity and can target REST/GraphQL/microservice/WebSocket), plus `guard`, `interceptor`, `pipe`, `filter`, `middleware`, `gateway`, `class` (`cl`), `decorator`, `provider`.

```bash
nest g module cats
nest g controller cats
nest g service cats
nest g resource cats          # full CRUD resource

# useful flags
nest g service cats --no-spec      # skip .spec.ts test file
nest g controller cats --flat      # don't create a containing directory
nest g resource cats --dry-run     # preview
nest g controller cats --project app   # target a project (monorepo)
```

### Build & start

`nest build` wraps `tsc`/`swc` (standard projects) or webpack + `ts-loader` (monorepos); handles `tsconfig-paths` out of the box. `nest start` ensures a build then runs `node` on the output.

```bash
nest build
nest start
nest start --watch        # rebuild + restart on change (start:dev)
nest start --debug --watch
nest start -b swc         # SWC builder (≈10x faster); add --type-check for CLI plugins
```

Recommended `package.json` scripts (use the **locally installed** CLI so the whole team runs the same version):

```json
"build": "nest build",
"start": "nest start",
"start:dev": "nest start --watch",
"start:debug": "nest start --debug --watch"
```

Build/start scripts honor `--path`, `--webpack`, `--webpackPath`. `nest new`/`nest generate` are not part of the build/exec pipeline and have no package scripts.

### nest-cli.json

Project config consumed by the CLI:

```javascript
{
  "collection": "@nestjs/schematics",   // default schematics collection
  "sourceRoot": "src",                  // source root
  "compilerOptions": {
    "plugins": ["@nestjs/swagger"],      // compiler plugins (e.g. Swagger)
    "webpack": false,                    // use webpack builder
    "deleteOutDir": true
  }
}
```

### Monorepo basics

`nest new` produces **standard mode** (separate file trees, separate `node_modules`/`package.json`, `tsc` compiler). **Monorepo mode** uses one file tree, shared `node_modules`/`package.json`/config, webpack by default, and built-in library support; `nest build`/`nest start` target the **default project** unless `--project <name>` is given. You can convert standard → monorepo later (e.g. `nest generate app`/`nest generate library`). See `/cli/monorepo` and `/cli/libraries`.

## Hot reload (webpack HMR)

Webpack HMR avoids full TypeScript recompiles on each change, speeding iterative dev. Caveat: webpack does not copy assets (e.g. `.graphql`) to `dist` and is incompatible with glob static paths (e.g. TypeORM `entities` globs).

With the CLI: `pnpm add -D webpack-node-externals run-script-webpack-plugin webpack`, then `webpack-hmr.config.js`:

```javascript
const nodeExternals = require('webpack-node-externals');
const { RunScriptWebpackPlugin } = require('run-script-webpack-plugin');

module.exports = function (options, webpack) {
  return {
    ...options,
    entry: ['webpack/hot/poll?100', options.entry],
    externals: [nodeExternals({ allowlist: ['webpack/hot/poll?100'] })],
    plugins: [
      ...options.plugins,
      new webpack.HotModuleReplacementPlugin(),
      new webpack.WatchIgnorePlugin({ paths: [/\.js$/, /\.d\.ts$/] }),
      new RunScriptWebpackPlugin({ name: options.output.filename, autoRestart: false }),
    ],
  };
};
```

Enable HMR in `main.ts`:

```typescript
declare const module: any;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
  if (module.hot) {
    module.hot.accept();
    module.hot.dispose(() => app.close());
  }
}
bootstrap();
```

Script: `"start:dev": "nest build --webpack --webpackPath webpack-hmr.config.js --watch"`. (Yarn Berry uses `webpack-pnp-externals` instead of `webpack-node-externals`. Without the CLI, hand-write a full `webpack.config.js` with `ts-loader` and run `webpack --config webpack.config.js --watch`.)

## Lifecycle events & graceful shutdown

Three phases: initializing → running → terminating. Hooks fire on modules, providers, and controllers (not request-scoped classes).

| Hook | When |
| --- | --- |
| `onModuleInit()` | Host module's deps resolved (needs `app.init()`/`app.listen()`) |
| `onApplicationBootstrap()` | All modules initialized, before listening |
| `onModuleDestroy()`* | After a termination signal received |
| `beforeApplicationShutdown()`* | After all `onModuleDestroy()` resolve; before connections close |
| `onApplicationShutdown(signal)`* | After connections close (`app.close()` resolved) |

\* Terminating hooks fire only on explicit `app.close()` **or** on a system signal (e.g. SIGTERM) when shutdown hooks are enabled. `onModuleInit`/`onApplicationBootstrap` order follows module import order (each awaited).

Implement the matching interface:

```typescript
import { Injectable, OnModuleInit, OnApplicationShutdown } from '@nestjs/common';

@Injectable()
export class UsersService implements OnModuleInit, OnApplicationShutdown {
  async onModuleInit(): Promise<void> { await this.fetch(); } // may be async
  onApplicationShutdown(signal: string) { console.log(signal); } // e.g. "SIGINT"
}
```

### Graceful shutdown (enableShutdownHooks)

Shutdown listeners consume resources and are **disabled by default**. Opt in at bootstrap so SIGTERM (etc.) triggers the terminating hooks — essential for Kubernetes/Heroku draining:

```typescript
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();   // start listening for shutdown signals
  await app.listen(process.env.PORT ?? 3000);
}
```

Notes: on receiving a signal Nest runs `onModuleDestroy` → `beforeApplicationShutdown` → `onApplicationShutdown` in order, awaiting any returned promises (and passing the signal). `app.close()` triggers the destroy/shutdown hooks but does **not** kill the Node process (clear intervals/long tasks yourself). Avoid `enableShutdownHooks` when running many Nest apps in one process (e.g. parallel Jest) — too many listeners. Windows: `SIGINT`/`SIGBREAK`/partial `SIGHUP` work; `SIGTERM` never does.
