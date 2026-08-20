import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateResourceSuggestionDto } from './dto/create-resource-suggestion.dto';
import { ResourceSuggestion } from './entities/resource-suggestion.entity';
import {
  ResourceSuggestionResponseDTO,
  toResourceSuggestionResponse,
} from './resource-suggestion-response';

/**
 * Member-facing submission: always lands `Pending` — see
 * `ResourceSuggestionStatus`'s doc. No auto-conversion into a
 * `ResourceListing` ever happens; that stays a deliberate, human, admin-side
 * act (`AdminResourceSuggestionsService`/`AdminResourceListingsService`).
 */
@Injectable()
export class ResourceSuggestionsService {
  constructor(
    @InjectRepository(ResourceSuggestion)
    private readonly suggestions: Repository<ResourceSuggestion>,
  ) {}

  async create(
    memberId: string,
    dto: CreateResourceSuggestionDto,
  ): Promise<ResourceSuggestionResponseDTO> {
    const saved = await this.suggestions.save(
      this.suggestions.create({
        memberId,
        category: dto.category,
        name: dto.name,
        description: dto.description,
        phone: dto.phone?.trim() ? dto.phone.trim() : null,
        email: dto.email?.trim() ? dto.email.trim() : null,
        website: dto.website?.trim() ? dto.website.trim() : null,
      }),
    );
    return toResourceSuggestionResponse(saved);
  }
}
