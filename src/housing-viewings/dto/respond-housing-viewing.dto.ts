import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** POST /housing-viewings/:id/accept — the party being asked picks one of the
 * proposed slots. */
export class AcceptHousingViewingDto {
  @IsDateString() slot!: string;
}

/** POST /housing-viewings/:id/propose — counter-propose new slots (with an
 * optional note). Flips whose proposal is on the table. */
export class ProposeHousingViewingDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsDateString({}, { each: true })
  slots!: string[];

  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

/** POST /housing-viewings/:id/decline — decline with an optional reason. */
export class DeclineHousingViewingDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
