import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ModAuditService } from '../moderation/mod-audit.service';
import { User } from '../users/entities/user.entity';
import { StudioAccessGrant } from './entities/studio-access-grant.entity';
import { STUDIO_AUDIT_ACTIONS } from './studio.constants';
import {
  STUDIO_ACCESS_GRANTED,
  StudioAccessGrantedEvent,
} from './studio.events';

/** `StudioAccessGrant` on the wire (contract `StudioAccessGrant`). */
export interface StudioAccessGrantResponse {
  userId: string;
  grantedAt: string;
  grantedBy: { id: string; displayName: string } | null;
}

/**
 * Studio v1 access grants. One row per member; the row is the grant. Grant
 * and revoke are idempotent, and each writes its `mod_audit_logs` row in the
 * same transaction as the change it records, only when something changed.
 *
 * Studio landing v2 (contract 12.4): a grant clears the member's waiting
 * access request in the grant transaction, from the Waiting for Studio list
 * and the member drawer alike, and a new grant tells the member through
 * `studio.access.granted` once the transaction has committed.
 */
@Injectable()
export class StudioAccessService {
  constructor(
    @InjectRepository(StudioAccessGrant)
    private readonly grants: Repository<StudioAccessGrant>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly modAudit: ModAuditService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  hasAccess(userId: string): Promise<boolean> {
    return this.grants.exists({ where: { userId } });
  }

  async getGrant(memberId: string): Promise<StudioAccessGrantResponse | null> {
    await this.assertMemberExists(memberId);
    const grant = await this.grants.findOne({ where: { userId: memberId } });
    return grant ? this.toResponse(grant) : null;
  }

  async grant(
    actorId: string,
    memberId: string,
  ): Promise<StudioAccessGrantResponse> {
    await this.assertMemberExists(memberId);
    const isNewGrant = await this.grants.manager.transaction(
      async (manager) => {
        const insertResult = await manager
          .createQueryBuilder()
          .insert()
          .into(StudioAccessGrant)
          .values({ userId: memberId, grantedById: actorId })
          .orIgnore()
          .returning(['id'])
          .execute();
        const isInserted = (insertResult.raw as unknown[]).length > 0;
        if (isInserted) {
          await this.modAudit.writeAuditLog(
            null,
            actorId,
            STUDIO_AUDIT_ACTIONS.accessGranted,
            undefined,
            undefined,
            undefined,
            manager,
            memberId,
          );
        }
        // Contract 12.4: whether or not the grant is new, the member stops waiting.
        await manager.query(
          'DELETE FROM "studio_access_requests" WHERE "user_id" = $1',
          [memberId],
        );
        return isInserted;
      },
    );
    if (isNewGrant) {
      this.eventEmitter.emit(STUDIO_ACCESS_GRANTED, {
        userId: memberId,
      } satisfies StudioAccessGrantedEvent);
    }
    const grant = await this.grants.findOne({ where: { userId: memberId } });
    if (!grant) {
      throw new NotFoundException('Member not found');
    }
    return this.toResponse(grant);
  }

  async revoke(actorId: string, memberId: string): Promise<void> {
    await this.assertMemberExists(memberId);
    await this.grants.manager.transaction(async (manager) => {
      const deleteResult = await manager.delete(StudioAccessGrant, {
        userId: memberId,
      });
      if ((deleteResult.affected ?? 0) > 0) {
        await this.modAudit.writeAuditLog(
          null,
          actorId,
          STUDIO_AUDIT_ACTIONS.accessRevoked,
          undefined,
          undefined,
          undefined,
          manager,
          memberId,
        );
      }
    });
  }

  private async assertMemberExists(memberId: string): Promise<void> {
    const doesMemberExist = await this.users.exists({
      where: { id: memberId },
    });
    if (!doesMemberExist) {
      throw new NotFoundException('Member not found');
    }
  }

  private async toResponse(
    grant: StudioAccessGrant,
  ): Promise<StudioAccessGrantResponse> {
    return {
      userId: grant.userId,
      grantedAt: grant.createdAt.toISOString(),
      grantedBy: grant.grantedById
        ? {
            id: grant.grantedById,
            displayName: await this.modAudit.nameForUserId(grant.grantedById),
          }
        : null,
    };
  }
}
