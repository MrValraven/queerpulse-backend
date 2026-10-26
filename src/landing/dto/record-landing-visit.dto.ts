import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RecordLandingVisitDto {
  @ApiPropertyOptional({
    description:
      'Where the visit came from: utm_source, else the referrer host, else empty. The server normalizes it and stores at most 64 characters.',
    maxLength: 256,
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  source?: string;
}
