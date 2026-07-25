import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { toImageUrl } from '../common/image-url';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { Vouch, type VouchRelationship } from './entities/vouch.entity';
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
    input?: {
      note?: string;
      relationship?: VouchRelationship | null;
      anonymous?: boolean;
    },
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

    // Empty/whitespace-only notes are stored as null, not "".
    const trimmedNote = input?.note?.trim();
    const cleanNote = trimmedNote ? trimmedNote : null;
    const relationship = input?.relationship ?? null;
    const anonymous = input?.anonymous ?? false;

    // One row per (voucher, vouchee) ever. If a withdrawn row exists, re-vouching
    // un-withdraws it (keeps id/createdAt) rather than 409-ing. An ACTIVE row is
    // a genuine duplicate.
    const existing = await this.vouches.findOne({
      where: { voucherId, voucheeId },
    });
    if (existing && existing.withdrawnAt === null) {
      throw new ConflictException('You have already vouched for this member');
    }

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
      if (existing) {
        // Withdrawn → reactivate in place.
        await manager.update(
          Vouch,
          { id: existing.id },
          { withdrawnAt: null, note: cleanNote, relationship, anonymous },
        );
      } else {
        try {
          await manager.insert(Vouch, {
            voucherId,
            voucheeId,
            note: cleanNote,
            relationship,
            anonymous,
          });
        } catch (err) {
          // The pre-check can be lost to a concurrent vouch; the UNIQUE
          // constraint is the real backstop. Map it to a 409, not a 500.
          if (isUniqueViolation(err)) {
            throw new ConflictException(
              'You have already vouched for this member',
            );
          }
          throw err;
        }
      }
      vouchCount = await manager.count(Vouch, {
        where: { voucheeId, withdrawnAt: IsNull() },
      });
    });
    this.eventEmitter.emit(VOUCH_CREATED, {
      voucherId,
      voucheeId,
    } satisfies VouchCreatedEvent);
    return { vouchCount };
  }

  /**
   * Insert a vouch inside the CALLER'S transaction, addressed by user ids
   * rather than a slug. The signup flow uses this to auto-vouch an inviter for
   * the member they brought in, so the vouch commits or rolls back together
   * with the account creation and invite claim.
   *
   * Deliberately does NOT emit VOUCH_CREATED — an event fired here would survive
   * a rollback of the caller's transaction. The caller emits it after commit
   * (see AuthService), the same way it emits USER_PROMOTED.
   *
   * Returns true when a row was inserted. Skips (returns false) a self-vouch;
   * this can't happen for a brand-new signup, but keeps the helper safe for any
   * caller. No duplicate handling: the target member is created in the same
   * transaction, so no prior (voucher, vouchee) row can exist.
   */
  async createVouchInTransaction(
    manager: EntityManager,
    voucherId: string,
    voucheeId: string,
    note?: string | null,
  ): Promise<boolean> {
    if (voucherId === voucheeId) {
      return false;
    }
    // Empty/whitespace-only notes are stored as null, not "" — same as createVouch.
    const trimmedNote = note?.trim();
    const cleanNote = trimmedNote ? trimmedNote : null;
    await manager.insert(Vouch, { voucherId, voucheeId, note: cleanNote });
    return true;
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
    // Soft-delete: keep the row (history + admin trust graph) but stamp
    // withdrawnAt so it drops out of every count/list. Only an ACTIVE row can
    // be withdrawn. Withdrawing never demotes — promotion is one-way.
    const active = await this.vouches.findOne({
      where: { voucherId, voucheeId: vouchee.userId, withdrawnAt: IsNull() },
    });
    if (!active) {
      throw new NotFoundException('No vouch to withdraw');
    }
    await this.vouches.update({ id: active.id }, { withdrawnAt: new Date() });
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
      where: { voucheeId: target.userId, withdrawnAt: IsNull() },
    });
    const rows = await this.vouches.find({
      where: { voucheeId: target.userId, withdrawnAt: IsNull() },
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
      where: { voucherId, withdrawnAt: IsNull() },
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
    return this.vouches.count({
      where: { voucheeId: userId, withdrawnAt: IsNull() },
    });
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
      .andWhere('v.withdrawnAt IS NULL')
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
