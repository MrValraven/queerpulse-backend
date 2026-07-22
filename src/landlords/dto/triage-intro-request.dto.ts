import { IsIn } from 'class-validator';

export class TriageIntroRequestDto {
  @IsIn(['accepted', 'declined'])
  action: 'accepted' | 'declined';
}
