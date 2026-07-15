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
 * The one write this module exposes: a reader pitching a story
 * (`SubmitStoryPage.tsx` "Submit for review"). No moderation/editorial
 * workflow lives here — authoring/admin CRUD for editorial content is out of
 * scope (spec §3 Tier 5 note).
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
    const saved = await this.submissions.save(
      this.submissions.create({
        userId,
        format: dto.format,
        workingTitle: dto.workingTitle,
        pitch: dto.pitch,
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
