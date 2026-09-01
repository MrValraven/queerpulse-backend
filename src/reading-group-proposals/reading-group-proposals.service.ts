import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { CreateReadingGroupProposalDto } from './dto/create-reading-group-proposal.dto';
import { ReadingGroupProposal } from './entities/reading-group-proposal.entity';
import {
  ReadingGroupProposalResponseDTO,
  toReadingGroupProposalResponse,
} from './reading-group-proposal-response';

@Injectable()
export class ReadingGroupProposalsService {
  constructor(
    @InjectRepository(ReadingGroupProposal)
    private readonly readingGroupProposals: Repository<ReadingGroupProposal>,
    private readonly adminQueueNotifications: AdminQueueNotificationsService,
  ) {}

  async create(
    memberId: string,
    dto: CreateReadingGroupProposalDto,
  ): Promise<ReadingGroupProposalResponseDTO> {
    const saved = await this.readingGroupProposals.save(
      this.readingGroupProposals.create({
        memberId,
        book: dto.book,
        why: dto.why?.trim() ? dto.why.trim() : null,
        format: dto.format,
        maxPeople: dto.maxPeople,
      }),
    );
    // Tell whoever works the reading-group-proposal queue that a suggestion
    // landed. Awaited, but safe to await: `announce` catches everything
    // internally, so a notification failure can never fail this write.
    await this.adminQueueNotifications.announce(
      AdminQueueKey.ReadingGroupProposals,
      saved.id,
    );
    return toReadingGroupProposalResponse(saved);
  }
}
