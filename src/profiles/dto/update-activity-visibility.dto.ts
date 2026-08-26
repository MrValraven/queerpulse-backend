import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * The member's opt-out for the coarse "recently active" band.
 *
 * `isHidden: true` hides the band from every other member and drops the member
 * out of the directory's "Recently active" ordering. It does not stop the month
 * being recorded: the value keeps updating so that turning the switch back on
 * shows the truth rather than a stale month from whenever they opted out.
 */
export class UpdateActivityVisibilityDto {
  @ApiProperty({
    description:
      'True to hide your activity band from other members and drop out of the "Recently active" sort.',
  })
  @IsBoolean()
  isHidden!: boolean;
}
