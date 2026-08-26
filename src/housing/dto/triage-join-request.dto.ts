import { IsIn } from 'class-validator';

export class TriageHousingJoinRequestDto {
  @IsIn(['accepted', 'declined'])
  action!: 'accepted' | 'declined';
}
