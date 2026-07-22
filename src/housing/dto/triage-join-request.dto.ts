import { IsIn } from 'class-validator';

export class TriageJoinRequestDto {
  @IsIn(['accepted', 'declined'])
  action: 'accepted' | 'declined';
}
