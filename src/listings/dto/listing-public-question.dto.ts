import { ListingPublicQuestion } from '../entities/listing-public-question.entity';

/**
 * The asker's live profile identity, resolved from `askerId`. Exactly the
 * fields `ReviewAuthor` exposes and no others: display name comes from the
 * snapshotted `askerName`, and these two make the name clickable and give it a
 * face. Absent (`null`) when the asker's account was erased or has no profile,
 * in which case the row renders unlinked, like a seeded review does.
 */
export interface ListingQuestionAsker {
  slug: string;
  avatarUrl: string | null;
}

/** Who wrote the answer, as the page must label it. */
export type ListingAnswerAuthorRole = 'owner' | 'moderator';

/**
 * One public question on a listing detail page, with its answer inline.
 *
 * Manually mapped, like every DTO in this module: there is no global
 * serializer, so returning the entity would ship `askerId`, `answeredById` and
 * every other column straight to an unauthenticated reader.
 *
 * Note what is NOT here: no `askerId`, no answerer identity beyond the ROLE.
 * The role is the part a reader needs (an answer from platform staff must never
 * read as the business speaking), and naming the individual moderator would
 * expose staff to exactly the pressure the role label avoids.
 */
export interface ListingPublicQuestionDTO {
  id: string;
  body: string;
  /** Snapshotted display name of the asker. */
  askerName: string;
  /** Profile slug, when the asker is still a member with a profile. */
  askerSlug: string | null;
  askerAvatarUrl: string | null;
  createdAt: string;
  answer: string | null;
  answeredAt: string | null;
  /** `null` while unanswered. */
  answeredByRole: ListingAnswerAuthorRole | null;
}

export function toListingPublicQuestionDTO(
  question: ListingPublicQuestion,
  asker: ListingQuestionAsker | null = null,
): ListingPublicQuestionDTO {
  const isAnswered = Boolean(question.answer);
  return {
    id: question.id,
    body: question.body,
    askerName: question.askerName,
    askerSlug: asker?.slug ?? null,
    askerAvatarUrl: asker?.avatarUrl ?? null,
    createdAt: question.createdAt.toISOString(),
    answer: question.answer,
    answeredAt:
      isAnswered && question.answeredAt
        ? question.answeredAt.toISOString()
        : null,
    answeredByRole: isAnswered
      ? question.isAnsweredByModerator
        ? 'moderator'
        : 'owner'
      : null,
  };
}
