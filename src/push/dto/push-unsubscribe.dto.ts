import { IsNotEmpty, IsString } from 'class-validator';

export class PushUnsubscribeDto {
  @IsString()
  @IsNotEmpty()
  endpoint!: string;
}
