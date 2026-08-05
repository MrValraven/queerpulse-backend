import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateSafeSpaceNominationDto } from './dto/create-safe-space-nomination.dto';
import { PaginationQuery } from './dto/pagination.query';
import { SafeSpaceNomination } from './entities/safe-space-nomination.entity';
import {
  AdminSafeSpaceNominationResponse,
  SafeSpaceNominationResponse,
  toAdminSafeSpaceNominationResponse,
  toSafeSpaceNominationResponse,
} from './safe-space-nomination-response';

@Injectable()
export class SafeSpaceNominationsService {
  constructor(
    @InjectRepository(SafeSpaceNomination)
    private readonly nominations: Repository<SafeSpaceNomination>,
  ) {}

  /** Record a member's nomination. Always lands in the `pending` queue. */
  async create(
    nominatorId: string,
    dto: CreateSafeSpaceNominationDto,
  ): Promise<SafeSpaceNominationResponse> {
    const nomination = this.nominations.create({
      nominatorId,
      placeName: dto.placeName.trim(),
      address: dto.address?.trim() || null,
      placeType: dto.placeType?.trim() || null,
      listingRef: dto.listingRef?.trim() || null,
      reason: dto.reason?.trim() || null,
      status: 'pending',
    });
    const saved = await this.nominations.save(nomination);
    return toSafeSpaceNominationResponse(saved);
  }

  /**
   * The admin review queue, newest first. Paginated so the console can page
   * through instead of loading every submission ever made.
   */
  async listForAdmin(
    page: PaginationQuery,
  ): Promise<{ items: AdminSafeSpaceNominationResponse[]; total: number }> {
    const limit = page.limit ?? 50;
    const offset = page.offset ?? 0;
    const [rows, total] = await this.nominations.findAndCount({
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });
    return {
      items: rows.map(toAdminSafeSpaceNominationResponse),
      total,
    };
  }
}
