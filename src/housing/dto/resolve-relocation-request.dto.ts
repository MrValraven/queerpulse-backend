import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * An operator/steward closing out a relocation request: `resolved` logs the
 * relocation outcome, `dismissed` closes it without one.
 */
export class ResolveRelocationRequestDto {
  @IsIn(['resolved', 'dismissed'])
  action!: 'resolved' | 'dismissed';

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(4000)
  outcome?: string;
}
