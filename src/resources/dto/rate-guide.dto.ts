import { IsIn, IsString } from 'class-validator';
import { GuideRatingValue } from '../entities/resource-guide-rating.entity';

// `POST /resources/guides/:contentKey/rating` body. Mirrors `VotePostDto`'s
// `@IsIn` restriction to exactly the two accepted values (no free-form
// string ever reaches the service or the DB's CHECK constraint).
export class RateGuideDto {
  @IsString()
  @IsIn(['helpful', 'not_helpful'])
  value!: GuideRatingValue;
}
