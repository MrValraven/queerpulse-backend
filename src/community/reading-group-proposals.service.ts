import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
    return toReadingGroupProposalResponse(saved);
  }
}
