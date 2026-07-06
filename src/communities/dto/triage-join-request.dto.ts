import { IsIn } from 'class-validator';

export class TriageJoinRequestDto {
  @IsIn(['approve', 'decline'])
  action: 'approve' | 'decline';
}
