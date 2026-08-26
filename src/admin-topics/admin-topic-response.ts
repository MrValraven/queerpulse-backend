import { Topic } from '../content/entities/topic.entity';

/**
 * One row of the admin topic directory.
 *
 * Hand-mapped from the entity (there is no global serializer in this
 * codebase), and deliberately wider than the member-facing `TopicResponse` in
 * `content/topic-response.ts`: the operating team needs the `id` to address a
 * row, the follower count, and whether the topic is archived. Nothing here is
 * sensitive, so the difference is convenience rather than confidentiality.
 */
export interface AdminTopicResponse {
  id: string;
  tag: string;
  label: string;
  description: string;
  totalPosts: number;
  followerCount: number;
  isCrisisCard: boolean;
  isArchived: boolean;
  /** ISO timestamp of the archive, or null while the topic is live. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toAdminTopicResponse(topic: Topic): AdminTopicResponse {
  return {
    id: topic.id,
    tag: topic.tag,
    label: topic.label,
    description: topic.description,
    totalPosts: topic.totalPosts,
    followerCount: topic.followerCount,
    isCrisisCard: topic.crisisCard,
    isArchived: Boolean(topic.archivedAt),
    archivedAt: topic.archivedAt ? topic.archivedAt.toISOString() : null,
    createdAt: topic.createdAt.toISOString(),
    updatedAt: topic.updatedAt.toISOString(),
  };
}
