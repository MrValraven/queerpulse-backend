import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

// `PATCH /mod/appeals/:id` body.
export class ReviewAppealDto {
  @IsIn(['uphold', 'overturn'])
  decision: 'uphold' | 'overturn';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
