import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * `POST /geocode/address` body — a free-text street address the wizard's
 * "Locate this address" button forwards so the server can resolve it to
 * coordinates (item #1). Bounded length: this is a single address line, not a
 * document.
 */
export class GeocodeAddressDto {
  @IsString() @IsNotEmpty() @MaxLength(300) address!: string;
}
