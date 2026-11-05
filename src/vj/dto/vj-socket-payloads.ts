/**
 * Payload classes of the `/vj` client frames (contract 6.6). The gateway's
 * ValidationPipe whitelists and forbids undeclared properties, so every field
 * a frame may carry is declared here. Fields are typed `unknown` and marked
 * `@Allow()` so `VjStageService` checks them in contract order and answers
 * the contract code. An undeclared property still meets the ValidationPipe.
 * Only the attach `role` (note 10) and the reauth `ticket` (copied from
 * `QuizshowReauthPayload`) are validated here.
 */
import { Allow, IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { VJ_ATTACH_ROLES, type VjAttachRole } from '../vj.contract';

/** `vj:attach`: a screen sends `screenId` and `restoreState`; a remote sends the role only. */
export class VjAttachPayloadDto {
  @IsIn(VJ_ATTACH_ROLES)
  role!: VjAttachRole;

  @Allow()
  screenId?: unknown;

  @Allow()
  restoreState?: unknown;
}

/** `session:reauth`: a single-use ticket from `POST /auth/socket-ticket`. */
export class VjReauthPayloadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  ticket!: string;
}

/** `stage:setPack`. */
export class VjSetPackPayloadDto {
  @Allow()
  clientId?: unknown;

  @Allow()
  commandSequence?: unknown;

  @Allow()
  packId?: unknown;
}

/** `stage:goClip`. */
export class VjGoClipPayloadDto {
  @Allow()
  clientId?: unknown;

  @Allow()
  commandSequence?: unknown;

  @Allow()
  clipId?: unknown;
}

/** `stage:setTransition`, a partial patch. */
export class VjSetTransitionPayloadDto {
  @Allow()
  clientId?: unknown;

  @Allow()
  commandSequence?: unknown;

  @Allow()
  mode?: unknown;

  @Allow()
  fadeMs?: unknown;
}

/** `stage:setOverlay`, a partial patch. */
export class VjSetOverlayPayloadDto {
  @Allow()
  clientId?: unknown;

  @Allow()
  commandSequence?: unknown;

  @Allow()
  text?: unknown;

  @Allow()
  style?: unknown;

  @Allow()
  isVisible?: unknown;
}

/** `stage:setEffects`, a partial patch. */
export class VjSetEffectsPayloadDto {
  @Allow()
  clientId?: unknown;

  @Allow()
  commandSequence?: unknown;

  @Allow()
  speed?: unknown;

  @Allow()
  isMonochrome?: unknown;

  @Allow()
  isMirrored?: unknown;

  @Allow()
  isHueCycling?: unknown;

  @Allow()
  isBlackout?: unknown;
}

/** `stage:setStrobe`. */
export class VjSetStrobePayloadDto {
  @Allow()
  clientId?: unknown;

  @Allow()
  commandSequence?: unknown;

  @Allow()
  isStrobing?: unknown;
}

/** `stage:setShuffle`, a partial patch. */
export class VjSetShufflePayloadDto {
  @Allow()
  clientId?: unknown;

  @Allow()
  commandSequence?: unknown;

  @Allow()
  isOn?: unknown;

  @Allow()
  intervalKind?: unknown;

  @Allow()
  intervalValue?: unknown;

  @Allow()
  bpm?: unknown;
}

/** `screen:advance`: the lead screen's shuffle report. */
export class VjScreenAdvancePayloadDto {
  @Allow()
  expectedClipSequence?: unknown;

  @Allow()
  clipId?: unknown;
}

/** `screen:status`: a screen's fullscreen flag and preload report. */
export class VjScreenStatusPayloadDto {
  @Allow()
  isFullscreen?: unknown;

  @Allow()
  preload?: unknown;
}
