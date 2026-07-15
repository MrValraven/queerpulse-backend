import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
    return toCommissionInterestResponse(saved);
  }
}
