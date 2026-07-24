import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { Profile } from './entities/profile.entity';
import { User, UserStatus } from './entities/user.entity';
import { Handle, HandleOwnerKind } from '../handles/entities/handle.entity';

// Bounds the slug-collision retry loop (see insertProfileWithUniqueSlug). This
// caps CONCURRENT contention only — each retry recomputes the next slug from the
// current max, so it is NOT a ceiling on how many same-named members can exist.
// It would only be exhausted by this many sign-ups racing the exact same base
// slug in the same instant.
const MAX_SLUG_ATTEMPTS = 5;

export interface CreateGoogleUserInput {
  googleId: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string | null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err.driverError as { code?: string })?.code === '23505'
  );
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
  ) {}

  // Sign-in lookup for a returning member. `addSelect('user.email')` re-includes
  // the `select: false` email column (see User.email) because the caller mints
  // an access token from the returned row, and the token embeds the email claim.
  findByGoogleId(googleId: string): Promise<User | null> {
    return this.usersRepo
      .createQueryBuilder('user')
      .addSelect('user.email')
      .where('user.googleId = :googleId', { googleId })
      .getOne();
  }

  findById(id: string): Promise<User | null> {
    return this.usersRepo.findOne({ where: { id } });
  }

  // Like `findById`, but re-includes the `select: false` email column — for the
  // token-refresh path, which re-mints an access token (with its email claim)
  // from a freshly loaded row. Ordinary `findById` deliberately omits email so
  // the PII stays unloaded everywhere that does not explicitly need it.
  findByIdWithEmail(id: string): Promise<User | null> {
    return this.usersRepo
      .createQueryBuilder('user')
      .addSelect('user.email')
      .where('user.id = :id', { id })
      .getOne();
  }

  findByIdWithProfile(id: string): Promise<User | null> {
    return this.usersRepo.findOne({
      where: { id },
      relations: { profile: true },
    });
  }

  // Current community size — active members only (pending/suspended excluded).
  countActiveMembers(): Promise<number> {
    return this.usersRepo.count({ where: { status: UserStatus.Active } });
  }

  // NOTE: `promoteToActive` used to live here. It has been removed along with
  // `UserStatus.Pending` — with no pending state there is nothing to promote
  // FROM. A member is created `Active` in a single step by `createGoogleUser`
  // once their invite validates at sign-up.

  async createGoogleUser(
    manager: EntityManager,
    input: CreateGoogleUserInput & {
      status?: UserStatus;
      invitedBy?: string | null;
      ageAttestedAt?: Date | null;
      termsVersion?: string | null;
      isSystem?: boolean;
    },
  ): Promise<User> {
    const status = input.status ?? UserStatus.Active;
    const user = manager.create(User, {
      googleId: input.googleId,
      email: input.email,
      status,
      activatedAt: status === UserStatus.Active ? new Date() : null,
      ageAttestedAt: input.ageAttestedAt ?? null,
      termsVersion: input.termsVersion ?? null,
      isSystem: input.isSystem ?? false,
      ...(input.invitedBy
        ? { invitedBy: { id: input.invitedBy } as User }
        : {}),
    });
    const saved = await manager.save(user);

    const base =
      this.slugify(`${input.firstName} ${input.lastName}`) || 'member';
    const slug = await this.nextAvailableSlug(manager, base);
    await this.insertProfileWithUniqueSlug(
      manager,
      saved.id,
      base,
      slug,
      input,
    );

    return saved;
  }

  // Inserts the profile, retrying with a bumped suffix if the slug collides on
  // insert (a 23505 the exists-check above raced past). Each attempt runs in a
  // SAVEPOINT (nested transaction) so a collision rolls back only this insert,
  // not the surrounding sign-up transaction.
  private async insertProfileWithUniqueSlug(
    manager: EntityManager,
    userId: string,
    base: string,
    slug: string,
    input: CreateGoogleUserInput,
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await manager.transaction(async (m) => {
          const profile = m.create(Profile, {
            userId,
            slug,
            firstName: input.firstName,
            lastName: input.lastName,
            avatarUrl: input.avatarUrl ?? null,
          });
          await m.save(profile);
          // Register the profile's username in the ONE global handle namespace
          // within the SAME savepoint (design plan PART C / UC2), so a collision
          // on the `handles` PK raises 23505 and reuses the existing suffix
          // retry below. `insert` (not `save`) guarantees an INSERT — `save`
          // would UPDATE an existing row and silently steal another user's
          // handle instead of colliding.
          await m.insert(Handle, {
            name: slug,
            ownerKind: HandleOwnerKind.Profile,
            userId,
          });
        });
        return;
      } catch (err) {
        if (isUniqueViolation(err) && attempt < MAX_SLUG_ATTEMPTS) {
          // A concurrent sign-up claimed `slug` between our query and this
          // insert. Recompute from the CURRENT max and retry, so only true
          // contention — never the count of same-named members — bounds us.
          slug = await this.nextAvailableSlug(manager, base);
          continue;
        }
        throw err;
      }
    }
  }

  // Picks the next free slug for `base` by finding the highest suffix already
  // taken and adding 1: `base`, then `base-1`, `base-2`, ... — so the Nth
  // "Tiago Costa" is `tiago-costa-(N-1)` regardless of how many already exist,
  // in a single query rather than probing one candidate at a time. Queries the
  // `handles` registry (not just `profiles`) because that is the ONE global
  // username namespace: a subprofile handle can occupy a suffix no profile holds.
  private async nextAvailableSlug(
    manager: EntityManager,
    base: string,
  ): Promise<string> {
    const taken = await manager
      .getRepository(Handle)
      .createQueryBuilder('handle')
      .select('handle.name', 'name')
      .where('handle.name = :base', { base })
      .orWhere('handle.name LIKE :prefix', { prefix: `${base}-%` })
      .getRawMany<{ name: string }>();

    // `base` itself counts as suffix 0; `base-<n>` counts as <n>. `base` is
    // slugified to [a-z0-9-] only, so it is safe to embed in the regex as-is.
    const suffixOf = new RegExp(`^${base}-(\\d+)$`);
    let maxSuffix = -1; // -1 => nothing taken, `base` is free
    for (const { name } of taken) {
      if (name === base) {
        maxSuffix = Math.max(maxSuffix, 0);
        continue;
      }
      const match = suffixOf.exec(name);
      if (match) maxSuffix = Math.max(maxSuffix, Number(match[1]));
    }

    return maxSuffix < 0 ? base : `${base}-${maxSuffix + 1}`;
  }

  private slugify(value: string): string {
    return value
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip accents
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}
