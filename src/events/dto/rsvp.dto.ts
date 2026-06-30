import { IsIn } from 'class-validator';

export class RsvpDto {
  @IsIn(['going', 'maybe'])
  status: 'going' | 'maybe';
}
