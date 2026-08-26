import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateTopicDto } from './create-topic.dto';

/**
 * `PATCH /admin/topics/:id` body. Every field optional, omitted fields left
 * untouched.
 *
 * `tag` is not editable. It is the topic's public URL (`/topic/:tag`), it is
 * the key `topic_follows` rows are stored under, and it is written into every
 * post that carries the hashtag, so renaming one would silently orphan every
 * follower and break every existing link. Retire the topic with the archive
 * route and create the new tag instead.
 */
export class UpdateTopicDto extends PartialType(
  OmitType(CreateTopicDto, ['tag'] as const),
) {}
