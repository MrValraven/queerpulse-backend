import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Profile } from './entities/profile.entity';
import { User, UserStatus } from './entities/user.entity';

export interface CreateGoogleUserInput {
  googleId: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string | null;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    private readonly dataSource: DataSource,
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
      ...(input.invitedBy ? { invitedBy: { id: input.invitedBy } as User } : {}),
    });
    const saved = await manager.save(user);

    const slug = await this.generateUniqueSlug(
      manager.getRepository(Profile),
      input.firstName,
      input.lastName,
    );
    const profile = manager.create(Profile, {
      userId: saved.id,
      slug,
      firstName: input.firstName,
      lastName: input.lastName,
      avatarUrl: input.avatarUrl ?? null,
    });
    await manager.save(profile);

    return saved;
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
