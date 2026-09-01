import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { CreateResourceSuggestionDto } from './dto/create-resource-suggestion.dto';
import { ResourceSuggestion } from './entities/resource-suggestion.entity';
import {
  MyResourceSuggestionsDTO,
  ResourceSuggestionResponseDTO,
  toMyResourceSuggestionDTO,
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
    private readonly adminQueueNotifications: AdminQueueNotificationsService,
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
    // Tell whoever works the resource-suggestion queue that a suggestion
    // landed. Awaited, but safe to await: `announce` catches everything
    // internally, so a notification failure can never fail the member's
    // submission.
    await this.adminQueueNotifications.announce(
      AdminQueueKey.ResourceSuggestions,
      saved.id,
    );
    return toResourceSuggestionResponse(saved);
  }

  /**
   * The submitter's own suggestions and what happened to each (PRD-45).
   *
   * Scoped to `memberId` from the session, never from a parameter: this is a
   * member's own resource, guarded exactly the way
   * `SafeSpaceNominationsController.listMine` is, so there is no id a caller
   * could swap to read somebody else's queue.
   *
   * ORDERING carries an `id` tiebreak on purpose. `created_at DESC` alone is
   * not a total order, and two suggestions written in the same transaction
   * share a `now()`, at which point Postgres is free to return them in either
   * order on either request and the list flickers between refetches. The same
   * defect was found on the housing and story queues in this codebase.
   *
   * Capped at 50, matching `SafeSpaceNominationsService.listMine`: this is a
   * personal tracker, not a paginated archive, and nobody has 50 pending
   * resource suggestions.
   */
  async listMine(memberId: string): Promise<MyResourceSuggestionsDTO> {
    const rows = await this.suggestions.find({
      where: { memberId },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: 50,
    });
    return { items: rows.map(toMyResourceSuggestionDTO) };
  }
}
