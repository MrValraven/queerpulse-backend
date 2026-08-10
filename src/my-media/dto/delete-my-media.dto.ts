import { IsNotEmpty, IsString } from 'class-validator';

export class DeleteMyMediaDto {
  @IsString()
  @IsNotEmpty()
  key!: string;
}
