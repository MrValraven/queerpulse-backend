import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { UserStatus } from '../users/entities/user.entity';
import { USER_PROMOTED, UserPromotedEvent } from '../users/user.events';
import { UsersService } from '../users/users.service';
import {
  JoinRequest,
  JoinRequestStatus,
} from './entities/join-request.entity';

@Injectable()
export class JoinRequestsService {
  constructor(
    @InjectRepository(JoinRequest)
    private readonly joinRequests: Repository<JoinRequest>,
    private readonly usersService: UsersService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async submit(userId: string, message: string): Promise<JoinRequest> {
    const user = await this.usersService.findById(userId);
    if (user && user.status === UserStatus.Active) {
      throw new BadRequestException('You are already an active member');
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
    return this.joinRequests.save(request);
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
    const request = await this.joinRequests.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException('Join request not found');
    }
    if (request.status !== JoinRequestStatus.Pending) {
      throw new ConflictException('Join request has already been reviewed');
    }
    request.status = status;
    request.reviewedBy = reviewerId;
    request.reviewedAt = new Date();
    const saved = await this.joinRequests.save(request);
    if (status === JoinRequestStatus.Approved) {
      const promoted = await this.usersService.promoteToActive(request.userId);
      if (promoted) {
        this.eventEmitter.emit(USER_PROMOTED, {
          userId: request.userId,
        } satisfies UserPromotedEvent);
      }
    }
    return saved;
  }
}
