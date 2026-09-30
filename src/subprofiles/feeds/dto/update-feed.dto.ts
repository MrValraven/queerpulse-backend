import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

// Body of `PATCH /subprofiles/:id/feeds/:feedId`. A new `section` applies to
// episodes published from now on; items already published stay where they
// are.
export class UpdateFeedDTO {
  @ApiPropertyOptional({ description: 'The section episodes publish into.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  section?: string;

  @ApiPropertyOptional({
    description: 'Publish new episodes straight away instead of queueing them.',
  })
  @IsOptional()
  @IsBoolean()
  autoPublish?: boolean;
}
