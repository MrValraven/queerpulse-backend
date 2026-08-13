import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateHousingSavedSearchDto } from './dto/create-housing-saved-search.dto';
import { HousingSavedSearch } from './entities/housing-saved-search.entity';
import { HousingSearchCriteria } from './housing-search-criteria';
import {
  HousingSavedSearchDTO,
  toHousingSavedSearchDTO,
} from './housing-saved-search-response';

/** A member can keep a generous but bounded number of saved searches — enough
 * for real use, capped so the alerts scan and the member's list stay small. */
const MAX_SAVED_SEARCHES_PER_MEMBER = 25;

/**
 * A member's named housing searches — create, list, delete. The alert fan-out
 * lives in the listener; this service owns only the member's own CRUD.
 */
@Injectable()
export class HousingSavedSearchesService {
  constructor(
    @InjectRepository(HousingSavedSearch)
    private readonly savedSearches: Repository<HousingSavedSearch>,
  ) {}

  async create(
    memberId: string,
    dto: CreateHousingSavedSearchDto,
  ): Promise<HousingSavedSearchDTO> {
    const count = await this.savedSearches.count({ where: { memberId } });
    if (count >= MAX_SAVED_SEARCHES_PER_MEMBER) {
      throw new ConflictException(
        `You can keep up to ${MAX_SAVED_SEARCHES_PER_MEMBER} saved searches`,
      );
    }
    // The DTO's criteria is already validated + whitelisted by the global pipe;
    // stored verbatim as the search's jsonb.
    const criteria: HousingSearchCriteria = { ...dto.criteria };
    const saved = await this.savedSearches.save(
      this.savedSearches.create({
        memberId,
        name: dto.name.trim(),
        criteria,
        alertsEnabled: dto.alertsEnabled ?? true,
      }),
    );
    return toHousingSavedSearchDTO(saved);
  }

  async listMine(memberId: string): Promise<HousingSavedSearchDTO[]> {
    const rows = await this.savedSearches.find({
      where: { memberId },
      order: { createdAt: 'DESC' },
    });
    return rows.map(toHousingSavedSearchDTO);
  }

  async remove(id: string, memberId: string): Promise<void> {
    // Scope the delete to the caller's own rows — a non-owner (or unknown id)
    // gets a 404, never another member's search.
    const result = await this.savedSearches.delete({ id, memberId });
    if (!result.affected) {
      throw new NotFoundException('Saved search not found');
    }
  }
}
