import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { UserStatus } from '../users/entities/user.entity';
import { USER_PROMOTED, UserPromotedEvent } from '../users/user.events';
import { UsersService } from '../users/users.service';
import { JoinRequest, JoinRequestStatus } from './entities/join-request.entity';

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err.driverError as { code?: string })?.code === '23505'
  );
}

@Injectable()
export class JoinRequestsService {
  constructor(
    @InjectRepository(JoinRequest)
    private readonly joinRequests: Repository<JoinRequest>,
    private readonly usersService: UsersService,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async submit(userId: string, message: string): Promise<JoinRequest> {
    const user = await this.usersService.findById(userId);
    // Only pending accounts submit join requests. Active users are already
    // members; suspended users have all member actions blocked (spec §4).
    if (user && user.status !== UserStatus.Pending) {
      throw new BadRequestException(
        user.status === UserStatus.Active
          ? 'You are already an active member'
          : 'Your account cannot submit a join request',
      );
    }
    const existing = await this.joinRequests.findOne({
      where: { userId, status: JoinRequestStatus.Pending },
    });
    if (existing) {
      throw new ConflictException('You already have a pending join request');
    }
    const request = this.joinRequests.create({
      userId,
      message,
      status: JoinRequestStatus.Pending,
    });
    try {
      return await this.joinRequests.save(request);
    } catch (err) {
      // The pre-check above races with a concurrent submit; the partial unique
      // index UQ_join_requests_pending_user is the real backstop. Map 23505 to
      // a 409 instead of a 500.
      if (isUniqueViolation(err)) {
        throw new ConflictException('You already have a pending join request');
      }
      throw err;
    }
  }

  list(status?: JoinRequestStatus): Promise<JoinRequest[]> {
    return this.joinRequests.find({
      where: status ? { status } : {},
      order: { createdAt: 'ASC' },
    });
  }

  async review(
    id: string,
    reviewerId: string,
    status: JoinRequestStatus.Approved | JoinRequestStatus.Declined,
  ): Promise<JoinRequest> {
    // The claim and the promotion run in one transaction on the same manager:
    // if promotion fails the review rolls back, so there is no "approved but
    // not promoted" stuck state.
    const { request, promoted } = await this.dataSource.transaction(
      async (manager) => {
        const repo = manager.getRepository(JoinRequest);
        const current = await repo.findOne({ where: { id } });
        if (!current) {
          throw new NotFoundException('Join request not found');
        }
        if (current.status !== JoinRequestStatus.Pending) {
          throw new ConflictException('Join request has already been reviewed');
        }
        const reviewedAt = new Date();
        // Conditional claim: only the reviewer who flips it out of pending wins;
        // a concurrent reviewer sees affected === 0 and is rejected.
        const claim = await repo.update(
          { id, status: JoinRequestStatus.Pending },
          { status, reviewedBy: reviewerId, reviewedAt },
        );
        if (claim.affected !== 1) {
          throw new ConflictException('Join request has already been reviewed');
        }
        current.status = status;
        current.reviewedBy = reviewerId;
        current.reviewedAt = reviewedAt;
        const didPromote =
          status === JoinRequestStatus.Approved
            ? await this.usersService.promoteToActive(current.userId, {
                manager,
              })
            : false;
        return { request: current, promoted: didPromote };
      },
    );
    // Emit only after commit so listeners never observe an uncommitted promotion.
    if (promoted) {
      this.eventEmitter.emit(USER_PROMOTED, {
        userId: request.userId,
      } satisfies UserPromotedEvent);
    }
    return request;
  }
}
