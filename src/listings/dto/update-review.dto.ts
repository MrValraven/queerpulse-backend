import { CreateReviewDto } from './create-review.dto';

/**
 * Body for `PATCH /directory/:slug/reviews/:reviewId` — the REVIEWER editing
 * their own review. Same shape as `CreateReviewDto` on purpose: a member gets
 * exactly one review per listing, so an edit replaces the whole thing rather
 * than patching a field of it, and the edit form sends back the same three
 * values it was seeded with.
 *
 * Consequences of that choice, stated so nobody has to infer them:
 *  - `stars` and `text` are required. There is no "leave the stars alone"
 *    request, because there is no form that would send one.
 *  - `photo` omitted means "no photo", the same as `photo: ''`. A partial-patch
 *    reading (omitted means "keep whatever is there") would make clearing the
 *    photo unexpressible without a second endpoint.
 */
export class UpdateReviewDto extends CreateReviewDto {}
