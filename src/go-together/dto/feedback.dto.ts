import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsObject, IsOptional } from 'class-validator';
import {
  GROUP_CLICK_ANSWERS,
  GroupClickAnswer,
} from '../entities/match-group-feedback.entity';

export class FeedbackDto {
  @ApiPropertyOptional({ description: 'member slug -> yes | maybe | no' })
  @IsOptional()
  @IsObject()
  verdicts?: Record<string, string>;

  @ApiPropertyOptional({ enum: GROUP_CLICK_ANSWERS })
  @IsOptional()
  @IsIn(GROUP_CLICK_ANSWERS)
  clicked?: GroupClickAnswer;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  goAgain?: boolean;
}
