import { MemberRef } from '../../common/member-ref';
import { ListingQuestion } from '../entities/listing-question.entity';

/** One question (and optional answer) of a listing's Q&A thread (item #17),
 * as returned by `GET /admin/listings/:ref/history` and
 * `POST /listings/:ref/questions/:id/answer`. Manually mapped — never the
 * raw `ListingQuestion` entity. */
export interface ListingQuestionDTO {
  id: string;
  body: string;
  answer: string | null;
  answeredAt: string | null;
  askedBy: MemberRef | null;
  createdAt: string;
}

export function toListingQuestionDTO(
  question: ListingQuestion,
  askedBy: MemberRef | null,
): ListingQuestionDTO {
  return {
    id: question.id,
    body: question.body,
    answer: question.answer,
    answeredAt: question.answeredAt ? question.answeredAt.toISOString() : null,
    askedBy,
    createdAt: question.createdAt.toISOString(),
  };
}
