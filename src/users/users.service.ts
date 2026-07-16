import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { Profile } from './entities/profile.entity';
import { User, UserStatus } from './entities/user.entity';
import { Handle, HandleOwnerKind } from '../handles/entities/handle.entity';

// Bounds the slug-collision retry loop (see insertProfileWithUniqueSlug).
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

  findByGoogleId(googleId: string): Promise<User | null> {
    return this.usersRepo.findOne({ where: { googleId } });
  }

  findById(id: string): Promise<User | null> {
    return this.usersRepo.findOne({ where: { id } });
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

  async promoteToActive(
    userId: string,
    opts?: { invitedBy?: string; manager?: EntityManager },
  ): Promise<boolean> {
    // Run against the caller's transaction manager when provided so promotion
    // can be atomic with the action that triggered it (e.g. invite acceptance).
    const repo = opts?.manager
      ? opts.manager.getRepository(User)
      : this.usersRepo;
    const user = await repo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    // One-way + idempotent: only pending accounts are promoted. Active stays
    // active; suspended is never auto-revived.
    if (user.status !== UserStatus.Pending) {
      return false;
    }
    user.status = UserStatus.Active;
    user.activatedAt = new Date();
    if (opts?.invitedBy) {
      user.invitedBy = { id: opts.invitedBy } as User;
    }
    await repo.save(user);
    return true;
  }

  async createGoogleUser(
    manager: EntityManager,
    input: CreateGoogleUserInput & {
      status?: UserStatus;
      invitedBy?: string | null;
    },
  ): Promise<User> {
    const status = input.status ?? UserStatus.Pending;
    const user = manager.create(User, {
      googleId: input.googleId,
      email: input.email,
      status,
      activatedAt: status === UserStatus.Active ? new Date() : null,
      ...(input.invitedBy
        ? { invitedBy: { id: input.invitedBy } as User }
        : {}),
    });
    const saved = await manager.save(user);

    const baseSlug = await this.generateUniqueSlug(
      manager.getRepository(Profile),
      input.firstName,
      input.lastName,
    );
    await this.insertProfileWithUniqueSlug(manager, saved.id, baseSlug, input);

    return saved;
  }

  // Inserts the profile, retrying with a bumped suffix if the slug collides on
  // insert (a 23505 the exists-check above raced past). Each attempt runs in a
  // SAVEPOINT (nested transaction) so a collision rolls back only this insert,
  // not the surrounding sign-up transaction.
  private async insertProfileWithUniqueSlug(
    manager: EntityManager,
    userId: string,
    baseSlug: string,
    input: CreateGoogleUserInput,
  ): Promise<void> {
    let slug = baseSlug;
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
          slug = `${baseSlug}-${attempt + 1}`;
          continue;
        }
        throw err;
      }
    }
  }

  private async generateUniqueSlug(
    repo: Repository<Profile>,
    firstName: string,
    lastName: string,
  ): Promise<string> {
    const base = this.slugify(`${firstName} ${lastName}`) || 'member';
    let slug = base;
    let suffix = 1;
    while (await repo.exists({ where: { slug } })) {
      slug = `${base}-${suffix++}`;
    }
    return slug;
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
