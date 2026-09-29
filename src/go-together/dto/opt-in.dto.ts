import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { LENSES, Lens } from '../go-together-questionnaire.catalog';

export class PairAnswersDto {
  @ApiPropertyOptional({
    description: 'questionId -> optionId for the host questions.',
  })
  @IsOptional()
  @IsObject()
  hostAnswers?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: LENSES, nullable: true })
  @IsOptional()
  @IsIn([...LENSES, null])
  lens?: Lens | null;

  @ApiPropertyOptional({ description: 'Required true when a lens is chosen.' })
  @IsOptional()
  @IsBoolean()
  lensConsent?: boolean;
}

export class OptInDto extends PairAnswersDto {
  @ApiProperty({ enum: ['solo', 'pair'] })
  @IsIn(['solo', 'pair'])
  mode!: 'solo' | 'pair';

  @ApiPropertyOptional({
    description: "The friend's profile slug when mode is pair.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  partnerSlug?: string;
}
