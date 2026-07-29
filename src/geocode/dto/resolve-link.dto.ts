import { IsString, IsUrl, MaxLength } from 'class-validator';

export class ResolveLinkDto {
  @IsString()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(2048)
  url!: string;
}
