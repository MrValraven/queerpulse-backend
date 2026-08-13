import { IsIn } from 'class-validator';

export class TriageGroupJoinRequestDto {
  @IsIn(['approved', 'declined'])
  action!: 'approved' | 'declined';
}
