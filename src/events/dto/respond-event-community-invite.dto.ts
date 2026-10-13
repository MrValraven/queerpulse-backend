import { IsIn } from 'class-validator';

export class RespondEventCommunityInviteDto {
  @IsIn(['accept', 'decline'])
  decision!: 'accept' | 'decline';
}
