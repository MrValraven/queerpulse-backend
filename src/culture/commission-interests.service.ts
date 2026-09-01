import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import {
  CommissionInterestResponseDTO,
  toCommissionInterestResponse,
} from './commission-interest-response';
import { CreateCommissionInterestDto } from './dto/create-commission-interest.dto';
import { CommissionInterest } from './entities/commission-interest.entity';

@Injectable()
export class CommissionInterestsService {
  constructor(
    @InjectRepository(CommissionInterest)
    private readonly commissionInterests: Repository<CommissionInterest>,
    private readonly adminQueueNotifications: AdminQueueNotificationsService,
  ) {}

  async create(
    memberId: string,
    dto: CreateCommissionInterestDto,
  ): Promise<CommissionInterestResponseDTO> {
    const saved = await this.commissionInterests.save(
      this.commissionInterests.create({
        memberId,
        commissionTitle: dto.commissionTitle,
        commissionCategory: dto.commissionCategory,
        recipientName: dto.recipientName,
        message: dto.message?.trim() ? dto.message.trim() : null,
      }),
    );
    // Tell whoever works the commission-interest queue that an interest
    // landed. Awaited, but safe to await: `announce` catches everything
    // internally, so a notification failure can never fail the member's
    // submission.
    await this.adminQueueNotifications.announce(
      AdminQueueKey.CommissionInterests,
      saved.id,
    );
    return toCommissionInterestResponse(saved);
  }
}
