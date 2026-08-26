import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateStorySubmissionDto } from './dto/create-story-submission.dto';
import { MagazineStorySubmission } from './entities/magazine-story-submission.entity';
import {
  StorySubmissionResponse,
  toStorySubmissionResponse,
} from './magazine-response';

/**
 * The member-facing side of story submissions: writing one, and reading your
 * own back with whatever the desk decided. The editorial DECISION lives on
 * `AdminStorySubmissionsService` (accept / decline / commission), guarded
 * separately — this service never mutates a status.
 */
@Injectable()
export class StorySubmissionsService {
  constructor(
    @InjectRepository(MagazineStorySubmission)
    private readonly submissions: Repository<MagazineStorySubmission>,
  ) {}

  async create(
    userId: string,
    dto: CreateStorySubmissionDto,
  ): Promise<StorySubmissionResponse> {
    const deck = dto.deck?.trim() || null;
    const body = dto.body?.trim() || null;
    const saved = await this.submissions.save(
      this.submissions.create({
        userId,
        format: dto.format,
        workingTitle: dto.workingTitle,
        pitch: dto.pitch,
        deck,
        body,
        // An empty string means "no cover" on every form in this codebase (see
        // `IsImageReference`), so normalise it to null rather than storing a
        // blank key that `toImageUrl` would then have to defend against.
        coverImageKey: dto.coverImageKey?.trim() || null,
      }),
    );
    return toStorySubmissionResponse(saved);
  }

  async listMine(userId: string): Promise<StorySubmissionResponse[]> {
    const rows = await this.submissions.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    return rows.map(toStorySubmissionResponse);
  }
}
