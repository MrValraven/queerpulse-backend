import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateChangemakerNominationDto } from './dto/create-changemaker-nomination.dto';
import { ChangemakerNomination } from './entities/changemaker-nomination.entity';
import {
  ChangemakerNominationResponseDTO,
  toChangemakerNominationResponse,
} from './changemaker-nomination-response';

@Injectable()
export class ChangemakerNominationsService {
  constructor(
    @InjectRepository(ChangemakerNomination)
    private readonly changemakerNominations: Repository<ChangemakerNomination>,
  ) {}

  async create(
    nominatorId: string,
    dto: CreateChangemakerNominationDto,
  ): Promise<ChangemakerNominationResponseDTO> {
    const saved = await this.changemakerNominations.save(
      this.changemakerNominations.create({
        nominatorId,
        nomineeName: dto.nomineeName.trim(),
      }),
    );
    return toChangemakerNominationResponse(saved);
  }
}
