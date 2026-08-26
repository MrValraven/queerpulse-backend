import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Topic } from '../content/entities/topic.entity';
import { TopicFollow } from '../topics/entities/topic-follow.entity';
import {
  AdminTopicResponse,
  toAdminTopicResponse,
} from './admin-topic-response';
import { CreateTopicDto } from './dto/create-topic.dto';
import { UpdateTopicDto } from './dto/update-topic.dto';

/**
 * Write side of the topic directory, for moderators and admins.
 *
 * Every read here passes `withDeleted` so archived topics stay visible to the
 * people who archived them. Member-facing reads (`content/topics.service.ts`)
 * do not, so TypeORM keeps archived rows out of the directory, the topic page,
 * the related-topics panel and global search on its own.
 */
@Injectable()
export class AdminTopicsService {
  constructor(
    @InjectRepository(Topic)
    private readonly topics: Repository<Topic>,
    @InjectRepository(TopicFollow)
    private readonly topicFollows: Repository<TopicFollow>,
  ) {}

  /** Every topic, archived ones included, alphabetically by tag. */
  async list(): Promise<AdminTopicResponse[]> {
    const rows = await this.topics.find({
      withDeleted: true,
      order: { tag: 'ASC' },
    });
    return rows.map(toAdminTopicResponse);
  }

  async create(dto: CreateTopicDto): Promise<AdminTopicResponse> {
    // `CreateTopicDto` already constrains the tag to the lowercase,
    // hyphen-separated shape `/topic/:tag` and the follow endpoints use, so it
    // is stored as given.
    const tag = dto.tag;

    // Checked against archived rows too: `UQ_topics_tag` covers them, so an
    // insert would fail anyway and this turns that into an answer the admin
    // can act on.
    const existing = await this.topics.findOne({
      where: { tag },
      withDeleted: true,
    });
    if (existing) {
      throw new ConflictException(
        existing.archivedAt
          ? `#${tag} already exists and is archived. Restore it instead of creating it again.`
          : `#${tag} already exists.`,
      );
    }

    const saved = await this.topics.save(
      this.topics.create({
        tag,
        label: dto.label.trim(),
        description: dto.description.trim(),
        crisisCard: dto.isCrisisCard ?? false,
      }),
    );
    return toAdminTopicResponse(saved);
  }

  async update(id: string, dto: UpdateTopicDto): Promise<AdminTopicResponse> {
    const topic = await this.loadOr404(id);

    if (dto.label !== undefined) topic.label = dto.label.trim();
    if (dto.description !== undefined) {
      topic.description = dto.description.trim();
    }
    if (dto.isCrisisCard !== undefined) topic.crisisCard = dto.isCrisisCard;

    const saved = await this.topics.save(topic);
    return toAdminTopicResponse(saved);
  }

  /**
   * Retire a topic without destroying it. The row, its posts and its followers
   * all stay, so `restore` puts it back exactly as it was. Idempotent: a
   * second archive leaves the original timestamp alone.
   */
  async archive(id: string): Promise<AdminTopicResponse> {
    const topic = await this.loadOr404(id);
    if (!topic.archivedAt) {
      await this.topics.softDelete(id);
    }
    return toAdminTopicResponse(await this.loadOr404(id));
  }

  /** Put an archived topic back in the directory. Idempotent. */
  async restore(id: string): Promise<AdminTopicResponse> {
    const topic = await this.loadOr404(id);
    if (topic.archivedAt) {
      await this.topics.restore(id);
    }
    return toAdminTopicResponse(await this.loadOr404(id));
  }

  /**
   * Destroy a topic, for one created in error. Its posts go with it
   * (`FK_topic_post_topic_id` cascades).
   *
   * Its follows go too, by slug: `topic_follows` carries no FK to this table,
   * so without this the rows would survive as invisible followers and a later
   * topic reusing the tag would inherit them while its `follower_count`
   * started at zero. Prefer `archive` for a topic anyone has used.
   */
  async remove(id: string): Promise<void> {
    const topic = await this.loadOr404(id);
    await this.topics.delete(id);
    await this.topicFollows.delete({ topicSlug: topic.tag });
  }

  private async loadOr404(id: string): Promise<Topic> {
    const topic = await this.topics.findOne({
      where: { id },
      withDeleted: true,
    });
    if (!topic) {
      throw new NotFoundException('Topic not found');
    }
    return topic;
  }
}
