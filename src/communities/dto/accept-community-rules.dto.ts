import { IsInt, Min } from 'class-validator';

/**
 * Body of `POST /communities/:slug/rules-acceptance`.
 *
 * The version is required rather than implied, for the same reason
 * `JoinCommunityDto.acceptedRulesVersion` is: the server records consent to a
 * specific revision of the text, so the client has to say which revision it
 * actually put in front of the member. A mismatch is refused instead of being
 * silently coerced to the current version.
 */
export class AcceptCommunityRulesDto {
  @IsInt()
  @Min(1)
  acceptedRulesVersion!: number;
}
