# NestJS Techniques: Config, Database, Validation, Serialization

Target: NestJS v11 + TypeScript. Stack: `@nestjs/config`, TypeORM + PostgreSQL (`@nestjs/typeorm`), `class-validator`/`class-transformer`, `@nestjs/cache-manager`, `@nestjs/throttler`, `@nestjs/axios`.

---

## Configuration (`@nestjs/config`)

Install: `pnpm add @nestjs/config`. Validation: `pnpm add joi`. Internally uses `dotenv` + `dotenv-expand`. Requires TypeScript >= 4.1.

### ConfigModule.forRoot options

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import databaseConfig from './config/database.config';
import * as Joi from 'joi';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,                 // no need to re-import in feature modules
      cache: true,                    // cache process.env reads (perf)
      expandVariables: true,          // ${VAR} interpolation via dotenv-expand
      envFilePath: ['.env.development.local', '.env.development', '.env'], // first match wins
      ignoreEnvFile: false,           // true => read only runtime env, skip .env file
      load: [configuration, databaseConfig], // factory + registerAs namespaces
      validationSchema: Joi.object({  // Joi schema (validates merged env)
        NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
        PORT: Joi.number().port().default(3000),
        DATABASE_URL: Joi.string().uri().required(),
      }),
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
  ],
})
export class AppModule {}
```

Key options:
- `isGlobal` — register `ConfigService` as a global provider (do this once in `AppModule`; feature modules then inject `ConfigService` without importing `ConfigModule`).
- `envFilePath` — string or string[]. Default `.env` in project root. If a var appears in multiple files, the **first** file wins. Runtime env vars (OS exports) take precedence over `.env` values (dotenv rule).
- `ignoreEnvFile: true` — do not load any `.env`, only `process.env`.
- `cache: true` — caches values; speeds up `ConfigService.get` for `process.env`-backed keys.
- `expandVariables: true` — enables `SUPPORT_EMAIL=support@${APP_URL}` style interpolation.
- `load` — array of factory functions (custom config files / `registerAs` namespaces).
- `validationSchema` — Joi schema; throws on startup if invalid. **Custom config files loaded via `load` are NOT validated by `validationSchema`** — validate inside the factory yourself.
- `validationOptions` — Joi options. `@nestjs/config` defaults: `allowUnknown: true`, `abortEarly: false`. If you pass a `validationOptions` object, unspecified keys fall back to **Joi** defaults (e.g. `allowUnknown` becomes `false`), so specify both explicitly.
- `validate` — alternative custom sync validate function (mutually with/instead of Joi; see below).
- `skipProcessEnv: true` — `get` reads only from custom config files, ignores `process.env`.
- `validatePredefined: false` — skip validation of process vars set before module import (e.g. `PORT=3000 node main.js`).

CLI: `nest start --env-file .env` loads env before bootstrap (Node >= 20 `--env-file`), useful for microservice config needed before `ConfigModule`.

### Custom configuration files (nested factory)

```typescript
// config/configuration.ts
export default () => ({
  port: parseInt(process.env.PORT, 10) || 3000,
  database: {
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT, 10) || 5432,
  },
});
```

Loaded via `load: [configuration]`. The factory controls casting/defaults. YAML config: parse with `js-yaml` `yaml.load(readFileSync(...))` inside the factory; remember to add non-TS assets to `compilerOptions.assets` in `nest-cli.json` so they are copied to `dist/`.

### Namespaced config with `registerAs` (recommended for typed, modular config)

```typescript
// config/database.config.ts
import { registerAs } from '@nestjs/config';

export default registerAs('database', () => ({
  host: process.env.DATABASE_HOST,
  port: parseInt(process.env.DATABASE_PORT, 10) || 5432,
  url: process.env.DATABASE_URL,
}));
```

Load with `load: [databaseConfig]`. Access via dot notation `configService.get('database.host')`, OR inject the namespace directly for strong typing:

```typescript
import { ConfigType } from '@nestjs/config';
import databaseConfig from './config/database.config';

constructor(
  @Inject(databaseConfig.KEY)
  private dbConfig: ConfigType<typeof databaseConfig>,
) {}
// this.dbConfig.host is fully typed
```

`.asProvider()` converts a namespace into a `forRootAsync`-compatible provider (no boilerplate):

```typescript
@Module({
  imports: [TypeOrmModule.forRootAsync(databaseConfig.asProvider())],
})
// equivalent to:
// { imports: [ConfigModule.forFeature(databaseConfig)],
//   useFactory: (c: ConfigType<typeof databaseConfig>) => c,
//   inject: [databaseConfig.KEY] }
```

### ConfigService.get with typing

```typescript
constructor(private configService: ConfigService) {}

const dbUser = this.configService.get<string>('DATABASE_USER');
const dbHost = this.configService.get<string>('database.host');         // nested
const dbHost2 = this.configService.get<string>('database.host', 'localhost'); // default value

interface DatabaseConfig { host: string; port: number; }
const dbConfig = this.configService.get<DatabaseConfig>('database');     // whole object
```

Two generics for compile-time safety:

```typescript
interface EnvironmentVariables { PORT: number; TIMEOUT: string; }

// First generic = known keys (prevents typo'd keys). Use { infer: true } to infer value type.
constructor(private configService: ConfigService<EnvironmentVariables>) {
  const port = this.configService.get('PORT', { infer: true }); // typeof port === number
}

// Second generic (true) = strict: strips `undefined` from return types (when strictNullChecks on)
constructor(private configService: ConfigService<{ PORT: number }, true>) {
  const port = this.configService.get('PORT', { infer: true }); // 'number', no assertion needed
}
```

`getOrThrow('KEY')` returns the value or throws if undefined (no `undefined` in return type).

### forFeature (partial registration)

```typescript
@Module({ imports: [ConfigModule.forFeature(databaseConfig)] })
export class DatabaseModule {}
```

Registers a namespace scoped to a feature module. Warning: because `forFeature()` runs during module init and init order is indeterminate, access partial-registration values in `onModuleInit()` rather than the constructor when another module depends on them.

### Custom validate function (class-validator instead of Joi)

```typescript
// env.validation.ts
import { plainToInstance } from 'class-transformer';
import { IsEnum, IsNumber, Max, Min, validateSync } from 'class-validator';

enum Environment { Development = 'development', Production = 'production', Test = 'test' }

class EnvironmentVariables {
  @IsEnum(Environment) NODE_ENV: Environment;
  @IsNumber() @Min(0) @Max(65535) PORT: number;
}

export function validate(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, { enableImplicitConversion: true });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) throw new Error(errors.toString());
  return validated;
}
```

Use via `ConfigModule.forRoot({ validate })`. Must be synchronous; throwing aborts bootstrap.

### Misc

- `ConditionalModule.registerWhen(FooModule, 'USE_FOO')` — load module only if env var not `false`; or pass `(env) => boolean`. Requires `ConfigModule` loaded; throws if `envVariablesLoaded` hook not flipped within 5s (configurable 3rd arg).
- `await ConfigModule.envVariablesLoaded` — promise resolving once env is loaded (for code needing `process.env` before DI).
- In `main.ts`: `const configService = app.get(ConfigService); const port = configService.get('PORT');`

---

## Database / TypeORM (`@nestjs/typeorm`)

Install (PostgreSQL): `pnpm add @nestjs/typeorm typeorm pg`. `forRoot()` accepts all TypeORM `DataSource` options plus extras: `retryAttempts` (default 10), `retryDelay` (default 3000ms), `autoLoadEntities` (default false).

### forRoot / forRootAsync with ConfigService (PostgreSQL)

```typescript
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('database.host'),
        port: config.get<number>('database.port'),
        username: config.get<string>('database.user'),
        password: config.get<string>('database.password'),
        database: config.get<string>('database.name'),
        // or: url: config.get<string>('DATABASE_URL'),
        autoLoadEntities: true,          // every forFeature entity auto-added to entities[]
        synchronize: config.get('NODE_ENV') !== 'production', // NEVER true in prod
        ssl: config.get('NODE_ENV') === 'production' ? { rejectUnauthorized: false } : false,
        // migrations + migrationsRun for prod, see Migrations below
      }),
    }),
  ],
})
export class AppModule {}
```

`forRootAsync` also supports `useClass: TypeOrmConfigService` (implements `TypeOrmOptionsFactory` with `createTypeOrmOptions(): TypeOrmModuleOptions`) and `useExisting: ConfigService`. With async config you can supply a `dataSourceFactory: async (options) => new DataSource(options).initialize()` to control DataSource creation.

`synchronize: true` must NOT be used in production — it can drop/alter columns and lose data. Use migrations instead. `autoLoadEntities: true` auto-includes every entity registered via `forFeature()`; entities only referenced via relations (not registered) are NOT auto-loaded.

After `forRoot`/`forRootAsync`, `DataSource` and `EntityManager` are globally injectable (no module import needed):

```typescript
constructor(private dataSource: DataSource) {}
```

### Entities (PostgreSQL, UUID PK, timestamps, soft delete)

```typescript
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, DeleteDateColumn,
  Index, Unique, OneToMany, ManyToOne, JoinColumn,
} from 'typeorm';

@Entity('users')                                  // table name
@Unique(['email'])                                // table-level unique constraint
@Index(['lastName', 'firstName'])                 // composite index
export class User {
  @PrimaryGeneratedColumn('uuid')                 // gen_random_uuid() / uuid_generate_v4()
  id: string;

  @Column({ type: 'varchar', length: 255, unique: true }) // column-level unique
  @Index()                                                // single-column index
  email: string;

  @Column({ type: 'varchar', nullable: true })
  firstName: string | null;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'enum', enum: ['admin', 'user'], default: 'user' })
  role: string;

  @Column({ select: false })                      // excluded from default SELECT (e.g. passwordHash)
  passwordHash: string;

  @CreateDateColumn({ type: 'timestamptz' })      // auto-set on insert
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })      // auto-updated on save
  updatedAt: Date;

  @DeleteDateColumn({ type: 'timestamptz' })      // set by softDelete/softRemove; enables soft delete
  deletedAt: Date | null;

  @OneToMany(() => Photo, (photo) => photo.user)
  photos: Photo[];
}
```

Notes: `@PrimaryGeneratedColumn('uuid')` generates UUID PKs (Postgres needs `pgcrypto`/`uuid-ossp` or TypeORM's default). Presence of `@DeleteDateColumn` makes `find` automatically exclude soft-deleted rows (use `withDeleted: true` to include). `timestamptz` recommended for Postgres.

### Relations

```typescript
// One-to-Many / Many-to-One (FK lives on the @ManyToOne / "many" side)
@Entity('photos')
export class Photo {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() url: string;

  @ManyToOne(() => User, (user) => user.photos, {
    onDelete: 'CASCADE',     // FK ON DELETE behavior
    eager: false,            // lazy by default; eager:true auto-joins on find
    nullable: false,
  })
  @JoinColumn({ name: 'user_id' })  // optional: name the FK column
  user: User;
}

// One-to-One (@JoinColumn goes on the OWNING side that holds the FK)
@OneToOne(() => Profile, { cascade: true })
@JoinColumn()
profile: Profile;

// Many-to-Many (@JoinTable on ONE owning side creates the junction table)
@ManyToMany(() => Category, (category) => category.posts)
@JoinTable({ name: 'post_categories' })
categories: Category[];
```

Relation options: `eager` (auto-load on `find`; only one side may be eager), `cascade` (insert/update related), `onDelete`/`onUpdate` (`'CASCADE'|'SET NULL'|'RESTRICT'`), `nullable`. Lazy relations: type the property `Promise<T[]>` and `await user.photos` (returns a promise; do not mix with eager). Load relations explicitly via `find({ relations: { photos: true } })` or QueryBuilder joins.

### forFeature, @InjectRepository, Repository API

```typescript
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [TypeOrmModule],   // re-export so other modules can @InjectRepository(User)
})
export class UsersModule {}
```

```typescript
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private usersRepository: Repository<User>,
  ) {}

  findAll(): Promise<User[]> { return this.usersRepository.find(); }

  findActive() {
    return this.usersRepository.find({
      where: { isActive: true },
      relations: { photos: true },
      order: { createdAt: 'DESC' },
      take: 20, skip: 0,
      withDeleted: false,
    });
  }

  findOne(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
    // shorthand: this.usersRepository.findOneBy({ id });
  }

  async create(dto: CreateUserDto): Promise<User> {
    const user = this.usersRepository.create(dto); // instantiate entity (no DB hit)
    return this.usersRepository.save(user);        // INSERT or UPDATE; runs hooks/timestamps
  }

  async update(id: string, dto: UpdateUserDto): Promise<void> {
    await this.usersRepository.update(id, dto);    // partial UPDATE by criteria; no entity load, no hooks
  }

  preloadUpdate(dto: UpdateUserDto) {
    return this.usersRepository.preload(dto);      // merge dto onto existing entity (or undefined)
  }

  remove(id: string)      { return this.usersRepository.delete(id); }      // hard DELETE by criteria
  removeEntity(u: User)   { return this.usersRepository.remove(u); }       // hard DELETE of loaded entity
  softRemove(id: string)  { return this.usersRepository.softDelete(id); }  // sets deletedAt
  restore(id: string)     { return this.usersRepository.restore(id); }     // clears deletedAt
}
```

Key API distinctions:
- `create()` instantiates (no DB), `save()` persists (insert OR update, fires subscribers/listeners, sets `@CreateDateColumn`/`@UpdateDateColumn`).
- `update()`/`delete()` operate by criteria, return `UpdateResult`/`DeleteResult`, are efficient but do **not** load entities or run entity lifecycle hooks; `save()`/`remove()` do.
- `softDelete()`/`restore()` toggle `@DeleteDateColumn`; `softRemove()`/`recover()` are entity-instance variants.
- `findOne` requires explicit `where`; `findOneBy({ id })` is the criteria shorthand. `findAndCount()` returns `[rows, total]`.
- `count`, `exists({ where })`, `upsert(entityOrArray, ['email'])` (Postgres ON CONFLICT).

Testing: mock repos via `getRepositoryToken(User)`:
```typescript
{ provide: getRepositoryToken(User), useValue: mockRepository }
```

### QueryBuilder

```typescript
const users = await this.usersRepository
  .createQueryBuilder('user')
  .leftJoinAndSelect('user.photos', 'photo')
  .where('user.isActive = :active', { active: true })
  .andWhere('user.email ILIKE :q', { q: `%${term}%` })  // Postgres case-insensitive
  .orderBy('user.createdAt', 'DESC')
  .skip(0).take(20)
  .getMany();

// raw/aggregate
const stats = await this.usersRepository
  .createQueryBuilder('user')
  .select('user.role', 'role')
  .addSelect('COUNT(*)', 'count')
  .groupBy('user.role')
  .getRawMany();
```

Always use parameterized `:name` bindings to avoid SQL injection.

### Transactions

QueryRunner (full control):
```typescript
async createMany(users: User[]) {
  const queryRunner = this.dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();
  try {
    await queryRunner.manager.save(users[0]);
    await queryRunner.manager.save(users[1]);
    await queryRunner.commitTransaction();
  } catch (err) {
    await queryRunner.rollbackTransaction();
    throw err;
  } finally {
    await queryRunner.release();   // required for manually-created runners
  }
}
```

Callback style (auto commit/rollback):
```typescript
async createMany(users: User[]) {
  await this.dataSource.transaction(async (manager) => {
    await manager.save(users[0]);
    await manager.save(users[1]);
  });
}
```
Inject `DataSource` (from `typeorm`) to start transactions. Note: subscribers cannot be request-scoped.

### Migrations (production: `synchronize: false`)

Migrations are owned by the TypeORM CLI, not Nest DI. Define a CLI `DataSource` (commonly `src/data-source.ts` or `ormconfig`):

```typescript
// data-source.ts
import { DataSource } from 'typeorm';
export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: ['dist/**/*.entity.js'],
  migrations: ['dist/migrations/*.js'],
  synchronize: false,
});
```

CLI (via `typeorm-ts-node-commonjs` or compiled JS):
```bash
# generate a migration from entity diffs
typeorm migration:generate src/migrations/Init -d dist/data-source.js
typeorm migration:create src/migrations/Manual     # empty migration
typeorm migration:run    -d dist/data-source.js     # apply pending
typeorm migration:revert -d dist/data-source.js     # roll back last
```

In `forRoot`/`forRootAsync` set `migrations: ['dist/migrations/*.js']`, `synchronize: false`, optionally `migrationsRun: true` to apply on boot. Each migration class implements `MigrationInterface` with `up(queryRunner)` / `down(queryRunner)`.

### Custom repository pattern

Preferred (v3+): extend the base repository and register as a provider.
```typescript
@Injectable()
export class UsersRepository extends Repository<User> {
  constructor(private dataSource: DataSource) {
    super(User, dataSource.createEntityManager());
  }
  findByEmail(email: string) { return this.findOne({ where: { email } }); }
}
// provide UsersRepository in the module's providers
```
Alternatively `dataSource.getRepository(User).extend({ ...customMethods })`.

### Subscribers, multiple DBs, manual DataSource

- Subscribers: `@EventSubscriber()` class implementing `EntitySubscriberInterface<T>` with `listenTo()` + hooks (`beforeInsert`, etc.); register in module `providers`. Cannot be request-scoped.
- Multiple databases: each `forRoot` needs a unique `name` (default `default`). `forFeature([Album], 'albumsConnection')`; inject with `@InjectRepository(Album, 'albumsConnection')`, `@InjectDataSource('name')`, `@InjectEntityManager('name')`. For `forRootAsync`, set `name` at the top level (outside `useFactory`).
- Recipe (`recipes/sql-typeorm`) — manual setup WITHOUT `@nestjs/typeorm` using a `DATA_SOURCE` async provider (`useFactory: async () => new DataSource({...}).initialize()`) and per-entity repository providers (`useFactory: (ds: DataSource) => ds.getRepository(Photo), inject: ['DATA_SOURCE']`). Prefer `@nestjs/typeorm` instead; the manual recipe is overhead.

---

## Validation (`class-validator` / `class-transformer`)

Install: `pnpm add class-validator class-transformer`. `ValidationPipe` is from `@nestjs/common`. Built-in parse pipes: `ParseIntPipe`, `ParseBoolPipe`, `ParseArrayPipe`, `ParseUUIDPipe`.

### Global ValidationPipe (recommended config)

```typescript
// main.ts
import { ValidationPipe } from '@nestjs/common';

app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,             // strip properties without validation decorators
    forbidNonWhitelisted: true,  // 400 if extra (non-whitelisted) props present
    transform: true,             // plain payload -> DTO instance; primitive coercion for params
    transformOptions: {
      enableImplicitConversion: true, // coerce based on TS type (e.g. "5" -> 5)
    },
    // disableErrorMessages: true,  // hide messages in production responses
    // forbidUnknownValues: true,   // fail on unknown objects (default true in recent versions)
  }),
);
```

`ValidationPipeOptions extends ValidatorOptions` adds `transform`, `disableErrorMessages`, `exceptionFactory(errors)`, `errorFormat: 'list' | 'grouped'`. Useful inherited `ValidatorOptions`: `whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`, `skipMissingProperties`, `skipUndefinedProperties`, `skipNullProperties`, `groups`, `stopAtFirstError`, `errorHttpStatusCode` (default `BadRequestException`/400).

With `transform: true`, primitive params auto-convert: `@Param('id') id: number` coerces `"5"` to `5`. `transformOptions.enableImplicitConversion` extends this to DTO fields based on declared TS types (otherwise add explicit `@Type(() => Number)`).

DTOs must be **classes**, not interfaces/generics (TS erases those at runtime). Do NOT use `import type { CreateUserDto }` — type-only imports are erased and break validation.

### DTOs and decorators

```typescript
import {
  IsString, IsEmail, IsEnum, IsOptional, IsUUID, IsInt, IsBoolean,
  IsArray, ValidateNested, MinLength, Min, Max, ArrayMinSize, Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

enum UserRole { Admin = 'admin', User = 'user' }

class AddressDto {
  @IsString() street: string;
  @IsString() city: string;
}

export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString() @MinLength(8)
  password: string;

  @IsOptional() @IsString()
  firstName?: string;

  @IsEnum(UserRole)
  role: UserRole;

  @IsOptional() @IsUUID('4')
  referrerId?: string;

  @IsInt() @Min(0) @Max(120) @Type(() => Number)
  age: number;

  @IsBoolean()
  isActive: boolean;

  @IsArray() @IsString({ each: true })   // validate each array element
  tags: string[];

  @ValidateNested()                       // recurse into nested object(s)
  @Type(() => AddressDto)                  // REQUIRED so class-transformer instantiates AddressDto
  address: AddressDto;

  @IsArray() @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AddressDto)
  addresses: AddressDto[];
}
```

`@ValidateNested()` requires `@Type(() => Class)` to be effective. `{ each: true }` applies a validator per array element. Common: `@IsNotEmpty`, `@IsNumber`, `@IsDateString`, `@IsUrl`, `@IsPositive`, `@Length`, `@Matches(regex)`, `@IsIn([...])`.

Param/query validation via DTO classes:
```typescript
import { IsNumberString } from 'class-validator';
export class FindOneParams { @IsUUID() id: string; }

@Get(':id')
findOne(@Param() params: FindOneParams) {}
```

### Mapped types (`@nestjs/mapped-types`)

Install: `pnpm add @nestjs/mapped-types`. (Use `@nestjs/swagger`'s versions instead if using Swagger; `@nestjs/graphql`'s for GraphQL — do not mix.)

```typescript
import { PartialType, PickType, OmitType, IntersectionType } from '@nestjs/mapped-types';

// All fields optional (typical Update DTO)
export class UpdateUserDto extends PartialType(CreateUserDto) {}

// Pick subset
export class UpdateAgeDto extends PickType(CreateUserDto, ['age'] as const) {}

// All except some
export class PublicUserDto extends OmitType(CreateUserDto, ['password'] as const) {}

// Combine two types
export class FullDto extends IntersectionType(CreateUserDto, AdditionalInfo) {}

// Composable
export class UpdateDto extends PartialType(OmitType(CreateUserDto, ['email'] as const)) {}
```

Mapped types preserve `class-validator` decorators from the source DTO.

### Array payloads

```typescript
@Post()
createBulk(
  @Body(new ParseArrayPipe({ items: CreateUserDto }))
  dtos: CreateUserDto[],
) {}

@Get()
findByIds(
  @Query('ids', new ParseArrayPipe({ items: Number, separator: ',' })) // GET /?ids=1,2,3
  ids: number[],
) {}
```
A bare `CreateUserDto[]` body cannot be validated (generics erased) — use `ParseArrayPipe` or wrap in a DTO with an array property.

### Error format

Default 400 response:
```json
{ "statusCode": 400, "error": "Bad Request", "message": ["email must be an email"] }
```
Customize with `exceptionFactory: (errors: ValidationError[]) => new BadRequestException(...)` or `errorFormat: 'grouped'` (object keyed by property path).

### Custom validators

```typescript
import { registerDecorator, ValidationOptions, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';

@ValidatorConstraint({ name: 'isStrongPassword', async: false })
export class IsStrongPasswordConstraint implements ValidatorConstraintInterface {
  validate(value: string) { return /[A-Z]/.test(value) && /\d/.test(value); }
  defaultMessage() { return 'password too weak'; }
}

export function IsStrongPassword(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({ target: object.constructor, propertyName, options,
      validator: IsStrongPasswordConstraint });
}
```
Async/DI-aware validators: implement constraint, register with `useContainer(app, { fallbackOnErrors: true })` in `main.ts`.

---

## Serialization (`ClassSerializerInterceptor`)

`ClassSerializerInterceptor` (from `@nestjs/common`) runs `instanceToPlain()` from `class-transformer` on the handler's return value, applying `@Exclude`/`@Expose`/`@Transform`. You MUST return a **class instance** — plain objects (or `{ user: new UserEntity() }` wrappers) are not transformed unless you use `@SerializeOptions({ type })`.

### Exclude / Expose / Transform

```typescript
import { Exclude, Expose, Transform } from 'class-transformer';

export class UserEntity {
  id: number;
  firstName: string;
  lastName: string;

  @Exclude()                        // never serialized (e.g. password)
  password: string;

  @Expose()                         // computed/aliased property
  get fullName(): string { return `${this.firstName} ${this.lastName}`; }

  @Transform(({ value }) => value?.name)  // serialize relation as its name only
  role: RoleEntity;

  constructor(partial: Partial<UserEntity>) { Object.assign(this, partial); }
}
```

Apply the interceptor:
```typescript
@UseInterceptors(ClassSerializerInterceptor)
@Get()
findOne(): UserEntity {
  return new UserEntity({ id: 1, firstName: 'John', lastName: 'Doe', password: 'secret' });
}
```
Or globally:
```typescript
import { APP_INTERCEPTOR } from '@nestjs/core';
{ provide: APP_INTERCEPTOR, useClass: ClassSerializerInterceptor }
```
Response excludes `password`.

### @SerializeOptions and transforming plain objects

```typescript
@UseInterceptors(ClassSerializerInterceptor)
@SerializeOptions({ type: UserEntity })   // plain objects auto-converted to UserEntity instances
@Get()
findOne(): UserEntity {
  return { id: 1, firstName: 'John', lastName: 'Doe', password: 'x' }; // serialized as UserEntity
}
```
`@SerializeOptions` (from `@nestjs/common`) passes options to `instanceToPlain()`. Common options: `excludePrefixes: ['_']`, `excludeExtraneousValues: true` (only `@Expose`-decorated props survive — strict whitelisting), `enableImplicitConversion`, `groups`, `strategy: 'excludeAll'`.

### plainToInstance (manual)

```typescript
import { plainToInstance } from 'class-transformer';
const user = plainToInstance(UserEntity, plainObj, { excludeExtraneousValues: true });
```

camelCase responses: define entity/DTO with camelCase properties and `@Expose({ name: 'snake_field' })` to map; or use `@Transform` for shape changes. `excludeExtraneousValues: true` + `@Expose()` on every output field guarantees only intended fields are returned. Note: serialization does NOT apply to `StreamableFile` responses; works the same for WebSockets/microservices.

---

## Caching (`@nestjs/cache-manager`)

Install: `pnpm add @nestjs/cache-manager cache-manager`. Uses Keyv under the hood; in-memory by default. TTL is in **milliseconds**; default `ttl: 0` means never expire.

```typescript
import { CacheModule } from '@nestjs/cache-manager';

@Module({ imports: [CacheModule.register({ isGlobal: true, ttl: 5000 })] })
export class AppModule {}
```

Inject the store:
```typescript
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

await this.cacheManager.get('key');            // undefined if missing (v6- returned null)
await this.cacheManager.set('key', 'value', 1000); // ttl ms; 0 = no expiry
await this.cacheManager.del('key');
await this.cacheManager.clear();
```

Auto-cache GET responses with `CacheInterceptor` (per-controller `@UseInterceptors(CacheInterceptor)` or global via `APP_INTERCEPTOR`). Only `GET` is cached; routes using `@Res()` cannot be cached. Override per-method with `@CacheKey('custom')` and `@CacheTTL(20)`. Custom tracking: subclass `CacheInterceptor` and override `trackBy(context): string | undefined`.

Redis store:
```typescript
import KeyvRedis from '@keyv/redis';
import { Keyv } from 'keyv';

CacheModule.registerAsync({
  useFactory: async () => ({
    stores: [new KeyvRedis('redis://localhost:6379')], // first = default, rest = fallback
  }),
});
```
Async: `registerAsync({ imports, useFactory, inject })` / `useClass` (`CacheOptionsFactory.createCacheOptions()`) / `useExisting`; supports `extraProviders`.

---

## Versioning

Enable in `main.ts` via `app.enableVersioning({ type })` using `VersioningType` (from `@nestjs/common`).

```typescript
import { VersioningType, VERSION_NEUTRAL } from '@nestjs/common';

// URI (default): /v1/route  — version prefixed with 'v' (configurable via prefix: 'v' | false)
app.enableVersioning({ type: VersioningType.URI });

// Header: value of a custom header is the version
app.enableVersioning({ type: VersioningType.HEADER, header: 'Custom-Header' });

// Media Type: Accept: application/json;v=2
app.enableVersioning({ type: VersioningType.MEDIA_TYPE, key: 'v=' });

// Custom: extractor returns string | string[] (sorted high->low)
app.enableVersioning({ type: VersioningType.CUSTOM, extractor });

// Global default for routes without an explicit version
app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' }); // or ['1','2'] or VERSION_NEUTRAL
```

Apply versions:
```typescript
import { Controller, Get, Version, VERSION_NEUTRAL } from '@nestjs/common';

@Controller({ version: '1' })                 // whole controller
@Controller({ version: ['1', '2'] })          // multiple versions
@Controller({ version: VERSION_NEUTRAL })     // matches any/no version

@Version('2') @Get('cats') findAllV2() {}     // per-route (overrides controller version)
```
Unmatched version => 404. Route-level `@Version` overrides controller version. Middleware can target a version: `forRoutes({ path: 'cats', method: RequestMethod.GET, version: '2' })`. Highest-matching selection from `extractor` arrays is reliable on Fastify, not Express.

---

## HTTP module (`@nestjs/axios`)

Install: `pnpm add @nestjs/axios axios`. Wraps Axios; `HttpService` methods return `AxiosResponse` wrapped in an RxJS `Observable`.

```typescript
import { HttpModule, HttpService } from '@nestjs/axios';

@Module({ imports: [HttpModule.register({ timeout: 5000, maxRedirects: 5 })] })
export class CatsModule {}

@Injectable()
export class CatsService {
  constructor(private readonly httpService: HttpService) {}

  findAll(): Observable<AxiosResponse<Cat[]>> {
    return this.httpService.get('http://localhost:3000/cats');
  }
}
```

Async config: `HttpModule.registerAsync({ imports: [ConfigModule], inject: [ConfigService], useFactory: (c) => ({ timeout: c.get('HTTP_TIMEOUT'), maxRedirects: c.get('HTTP_MAX_REDIRECTS') }) })` — also `useClass` (`HttpModuleOptionsFactory.createHttpOptions()`) / `useExisting`; supports `extraProviders`.

Promise + error handling (recommended):
```typescript
import { catchError, firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';

async findAll(): Promise<Cat[]> {
  const { data } = await firstValueFrom(
    this.httpService.get<Cat[]>('http://localhost:3000/cats').pipe(
      catchError((error: AxiosError) => { this.logger.error(error.response?.data); throw 'request failed'; }),
    ),
  );
  return data;
}
```
Underlying Axios instance: `this.httpService.axiosRef.get(...)` (returns a native Promise). Use `firstValueFrom`/`lastValueFrom` from `rxjs` to convert Observables to Promises.

---

## Throttler (`@nestjs/throttler`) — project stack note

Install: `pnpm add @nestjs/throttler`. Register named throttlers and bind globally:
```typescript
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

@Module({
  imports: [ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60000, limit: 10 }] })], // ttl ms
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
```
Per-route override `@Throttle({ default: { ttl: 60000, limit: 3 } })`; skip with `@SkipThrottle()`. Async config via `forRootAsync({ inject: [ConfigService], useFactory })`. Storage adapters available for Redis (`@nest-lab/throttler-storage-redis`) in multi-instance deployments.
