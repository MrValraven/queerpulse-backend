import { IsIn, IsString, Length } from 'class-validator';

export class FaceDto {
  @IsString()
  @Length(1, 4)
  initials: string;

  @IsIn(['coral', 'jade', 'plum'])
  tint: 'coral' | 'jade' | 'plum';
}
