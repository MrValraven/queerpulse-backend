import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { validateDeskViewQuery } from './desk-view-query.validation';
import {
  CreateDeskViewDto,
  DESK_VIEWS_PER_OWNER_MAX,
} from './dto/create-desk-view.dto';
import { UpdateDeskViewDto } from './dto/update-desk-view.dto';
import {
  DeskViewQuery,
  MagazineDeskView,
} from './entities/magazine-desk-view.entity';

const OWNER_NAME_CONSTRAINT = 'UQ_magazine_desk_view_owner_name';

/** One saved view as the desk reads it, hand-mapped from the row. */
export interface DeskViewResponse {
  id: string;
  name: string;
  query: DeskViewQuery;
  position: number;
}

export function toDeskViewResponse(view: MagazineDeskView): DeskViewResponse {
  return {
    id: view.id,
    name: view.name,
    query: view.query,
    position: view.position,
  };
}

/**
 * Per-editor saved desk views. Every method takes the caller's user id and
 * scopes to it, so an editor only ever sees, changes or deletes their own
 * views. Someone else's view id answers 404, the same as a missing one, so
 * the endpoint never confirms that another editor's view exists.
 */
@Injectable()
export class MagazineDeskViewsService {
  constructor(
    @InjectRepository(MagazineDeskView)
    private readonly views: Repository<MagazineDeskView>,
  ) {}

  async listViews(ownerId: string): Promise<DeskViewResponse[]> {
    const views = await this.ownerViewsInOrder(ownerId);
    return views.map(toDeskViewResponse);
  }

  /** Appends a view to the end of the owner's list. */
  async createView(
    ownerId: string,
    dto: CreateDeskViewDto,
  ): Promise<DeskViewResponse> {
    const query = validateDeskViewQuery(dto.query);
    const existing = await this.ownerViewsInOrder(ownerId);

    if (existing.length >= DESK_VIEWS_PER_OWNER_MAX) {
      throw new ConflictException(
        `You can keep up to ${DESK_VIEWS_PER_OWNER_MAX} saved views. Delete one to save another.`,
      );
    }
    if (existing.some((view) => view.name === dto.name)) {
      throw this.duplicateNameConflict();
    }

    const lastPosition = existing.at(-1)?.position ?? -1;
    const view = this.views.create({
      ownerId,
      name: dto.name,
      query,
      position: lastPosition + 1,
    });
    await this.saveOrConflict(view);
    return toDeskViewResponse(view);
  }

  /** Renames, moves, or replaces the stored query of one of the owner's views. */
  async updateView(
    ownerId: string,
    viewId: string,
    dto: UpdateDeskViewDto,
  ): Promise<DeskViewResponse> {
    const ownerViews = await this.ownerViewsInOrder(ownerId);
    const view = ownerViews.find((candidate) => candidate.id === viewId);
    if (!view) {
      throw new NotFoundException('Saved view not found');
    }

    if (dto.name !== undefined && dto.name !== view.name) {
      const isNameTaken = ownerViews.some(
        (candidate) => candidate.id !== viewId && candidate.name === dto.name,
      );
      if (isNameTaken) {
        throw this.duplicateNameConflict();
      }
      view.name = dto.name;
    }
    if (dto.query !== undefined) {
      view.query = validateDeskViewQuery(dto.query);
    }

    if (dto.position === undefined) {
      await this.saveOrConflict(view);
      return toDeskViewResponse(view);
    }

    // Move: take the view out, put it back at the requested index (clamped to
    // the end of the list), and renumber everyone 0..n-1 so the list never
    // carries gaps or ties after a reorder. A multi-entity `save` runs in one
    // transaction.
    const reordered = ownerViews.filter((candidate) => candidate.id !== viewId);
    const targetIndex = Math.min(dto.position, reordered.length);
    reordered.splice(targetIndex, 0, view);
    reordered.forEach((candidate, index) => {
      candidate.position = index;
    });
    await this.saveOrConflict(reordered);
    return toDeskViewResponse(view);
  }

  async deleteView(ownerId: string, viewId: string): Promise<void> {
    const result = await this.views.delete({ id: viewId, ownerId });
    if (!result.affected) {
      throw new NotFoundException('Saved view not found');
    }
  }

  private ownerViewsInOrder(ownerId: string): Promise<MagazineDeskView[]> {
    return this.views.find({
      where: { ownerId },
      order: { position: 'ASC', createdAt: 'ASC' },
    });
  }

  private duplicateNameConflict(): ConflictException {
    return new ConflictException(
      'You already have a saved view with this name.',
    );
  }

  /** Two tabs saving the same name at once both pass the in-memory check; the
   *  unique constraint catches the loser, which reads as the same 409. */
  private async saveOrConflict(
    toSave: MagazineDeskView | MagazineDeskView[],
  ): Promise<void> {
    try {
      if (Array.isArray(toSave)) {
        await this.views.save(toSave);
      } else {
        await this.views.save(toSave);
      }
    } catch (error) {
      if (isUniqueViolation(error, OWNER_NAME_CONSTRAINT)) {
        throw this.duplicateNameConflict();
      }
      throw error;
    }
  }
}
