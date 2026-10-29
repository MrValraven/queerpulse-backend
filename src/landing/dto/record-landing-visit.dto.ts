import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { LANDING_VISIT_PAGES, LandingVisitPage } from '../landing-visit-source';

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

  @ApiPropertyOptional({
    description: 'The page that was visited. Absent reads home.',
    enum: LANDING_VISIT_PAGES,
  })
  @IsOptional()
  @IsIn(LANDING_VISIT_PAGES)
  page?: LandingVisitPage;
}
