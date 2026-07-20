import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, In, QueryFailedError, Repository } from 'typeorm';
import { toImageUrl } from '../common/image-url';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { Vouch } from './entities/vouch.entity';
import { VOUCH_CREATED, VouchCreatedEvent } from './vouch.events';

// Bounds an otherwise-unbounded list read; callers may narrow with limit/offset.
const DEFAULT_PAGE_SIZE = 20;

export interface PageParams {
  limit?: number;
  offset?: number;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err.driverError as { code?: string })?.code === '23505'
  );
}

export interface VoucherView {
  slug: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  note: string | null;
  createdAt: Date;
}

export interface GivenVouchView {
  slug: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  note: string | null;
  createdAt: Date;
}

@Injectable()
export class VouchService {
  constructor(
    @InjectRepository(Vouch) private readonly vouches: Repository<Vouch>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async createVouch(
    voucherId: string,
    voucheeSlug: string,
    note?: string,
  ): Promise<{ vouchCount: number }> {
    const vouchee = await this.profiles.findOne({
      where: { slug: voucheeSlug },
    });
    if (!vouchee) {
      throw new NotFoundException('Member not found');
    }
    const voucheeId = vouchee.userId;
    if (voucheeId === voucherId) {
      throw new BadRequestException('You cannot vouch for yourself');
    }
    const existing = await this.vouches.findOne({
      where: { voucherId, voucheeId },
    });
    if (existing) {
      throw new ConflictException('You have already vouched for this member');
    }

    // Empty/whitespace-only notes are stored as null, not "".
    const trimmedNote = note?.trim();
    const cleanNote = trimmedNote ? trimmedNote : null;

    // Vouches are a trust/recognition signal ONLY — they no longer gate
    // membership. The threshold-crossing promotion that used to live here died
    // with `UserStatus.Pending`: its target was "a pending account reaching N
    // vouches", and there are no pending accounts. Membership is decided by
    // invite (or by an admin approving a join request), never by accumulation.
    let vouchCount = 0;
    await this.dataSource.transaction(async (manager) => {
      // Take a write lock on the vouchee row first so concurrent vouches for
      // the same member serialize and `vouchCount` below is read consistently
      // rather than from a racing snapshot. The lock is held to commit.
      await manager.findOne(User, {
        where: { id: voucheeId },
        lock: { mode: 'pessimistic_write' },
      });
      try {
        await manager.insert(Vouch, {
          voucherId,
          voucheeId,
          note: cleanNote,
        });
      } catch (err) {
        // The pre-check above can be lost to a concurrent vouch; the UNIQUE
        // constraint is the real backstop. Map it to a 409, not a 500.
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            'You have already vouched for this member',
          );
        }
        throw err;
      }
      vouchCount = await manager.count(Vouch, { where: { voucheeId } });
    });
    this.eventEmitter.emit(VOUCH_CREATED, {
      voucherId,
      voucheeId,
    } satisfies VouchCreatedEvent);
    return { vouchCount };
  }

  async withdrawVouch(
    voucherId: string,
    voucheeSlug: string,
  ): Promise<{ ok: true }> {
    const vouchee = await this.profiles.findOne({
      where: { slug: voucheeSlug },
    });
    if (!vouchee) {
      throw new NotFoundException('Member not found');
    }
    // Withdrawing never demotes — promotion is one-way (spec §4).
    const result = await this.vouches.delete({
      voucherId,
      voucheeId: vouchee.userId,
    });
    if (!result.affected) {
      throw new NotFoundException('No vouch to withdraw');
    }
    return { ok: true };
  }

  async listVouchers(
    slug: string,
    page?: PageParams,
  ): Promise<{ count: number; vouchers: VoucherView[] }> {
    const target = await this.profiles.findOne({ where: { slug } });
    if (!target) {
      throw new NotFoundException('Member not found');
    }
    // `count` is the full tally; `rows` is the requested (bounded) page.
    const count = await this.vouches.count({
      where: { voucheeId: target.userId },
    });
    const rows = await this.vouches.find({
      where: { voucheeId: target.userId },
      order: { createdAt: 'DESC' },
      take: page?.limit ?? DEFAULT_PAGE_SIZE,
      skip: page?.offset ?? 0,
    });
    const voucherProfiles = await this.profilesByUserIds(
      rows.map((v) => v.voucherId),
    );
    const vouchers = rows.map((v) =>
      this.toVouchView(voucherProfiles.get(v.voucherId), v.note, v.createdAt),
    );
    return { count, vouchers };
  }

  async listGiven(
    voucherId: string,
    page?: PageParams,
  ): Promise<GivenVouchView[]> {
    const rows = await this.vouches.find({
      where: { voucherId },
      order: { createdAt: 'DESC' },
      take: page?.limit ?? DEFAULT_PAGE_SIZE,
      skip: page?.offset ?? 0,
    });
    const voucheeProfiles = await this.profilesByUserIds(
      rows.map((v) => v.voucheeId),
    );
    return rows.map((v) =>
      this.toVouchView(voucheeProfiles.get(v.voucheeId), v.note, v.createdAt),
    );
  }

  getVouchCount(userId: string): Promise<number> {
    return this.vouches.count({ where: { voucheeId: userId } });
  }

  async getVouchCounts(userIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (!userIds.length) {
      return map;
    }
    const rows = await this.vouches
      .createQueryBuilder('v')
      .select('v.voucheeId', 'voucheeId')
      .addSelect('COUNT(*)', 'count')
      .where('v.voucheeId IN (:...ids)', { ids: userIds })
      .groupBy('v.voucheeId')
      .getRawMany<{ voucheeId: string; count: string }>();
    for (const row of rows) {
      map.set(row.voucheeId, parseInt(row.count, 10));
    }
    return map;
  }

  private async profilesByUserIds(
    userIds: string[],
  ): Promise<Map<string, Profile>> {
    if (!userIds.length) {
      return new Map();
    }
    const profiles = await this.profiles.find({
      where: { userId: In(userIds) },
    });
    return new Map(profiles.map((p) => [p.userId, p]));
  }

  private toVouchView(
    profile: Profile | undefined,
    note: string | null,
    createdAt: Date,
  ): VoucherView {
    return {
      slug: profile?.slug ?? '',
      firstName: profile?.firstName ?? '',
      lastName: profile?.lastName ?? '',
      avatarUrl: toImageUrl(profile?.avatarUrl),
      note,
      createdAt,
    };
  }
}
