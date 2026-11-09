/**
 * Payload classes of the `/vj` client frames (contract v2 7.5, v1 6.6). The
 * gateway's ValidationPipe whitelists and forbids undeclared properties, so
 * every field a frame may carry is declared here. Fields are typed `unknown`
 * and marked `@Allow()` so the stage rules check them in contract order and
 * answer the contract code. An undeclared property still meets the
 * ValidationPipe. Only the attach `role` (v1 note 10) and the reauth `ticket`
 * (copied from `QuizshowReauthPayload`) are validated here.
 */
import {
  Allow,
  Equals,
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';
import { VJ_ATTACH_ROLES, type VjAttachRole } from '../vj.contract';

/** `vj:attach`: a screen sends `screenId` and `restoreState`; a remote sends
 *  the role only. Both send `contractVersion` (contract 7.1). */
export class VjAttachPayloadDto {
  @IsIn(VJ_ATTACH_ROLES)
  role!: VjAttachRole;

  @Allow()
  contractVersion?: unknown;

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

/**
 * The stamp every remote command carries (`VjClientCommandFields`, v1 6.6),
 * plus `isImmediate`. `isImmediate` is declared on every stamped command so
 * the whitelisting pipe never answers a generic refusal for it: the rule kit's
 * `readVjImmediateFlag` reads it and answers `vj_effect_flag_invalid` or
 * `vj_immediate_not_allowed` (contract 7.4). Only a blackout-only
 * `stage:setEffects`, `stage:setStrobe` with `isStrobing: false` and
 * `stage:resetLook` honour it.
 */
export class VjRemoteCommandPayloadDto {
  @Allow()
  clientId?: unknown;

  @Allow()
  commandSequence?: unknown;

  @Allow()
  isImmediate?: unknown;
}

/** `stage:setPack`. */
export class VjSetPackPayloadDto extends VjRemoteCommandPayloadDto {
  @Allow()
  packId?: unknown;
}

/** `stage:goClip`. */
export class VjGoClipPayloadDto extends VjRemoteCommandPayloadDto {
  @Allow()
  clipId?: unknown;
}

/** `stage:goGenerator`: a generator id or null, with an optional variant. */
export class VjGoGeneratorPayloadDto extends VjRemoteCommandPayloadDto {
  @Allow()
  generatorId?: unknown;

  @Allow()
  variant?: unknown;
}

/** `stage:setTransition`, a partial patch: a transition id and a length. */
export class VjSetTransitionPayloadDto extends VjRemoteCommandPayloadDto {
  @Allow()
  mode?: unknown;

  @Allow()
  length?: unknown;
}

/** `stage:setOverlay`, a partial patch. */
export class VjSetOverlayPayloadDto extends VjRemoteCommandPayloadDto {
  @Allow()
  text?: unknown;

  @Allow()
  style?: unknown;

  @Allow()
  isVisible?: unknown;

  @Allow()
  position?: unknown;

  @Allow()
  size?: unknown;

  @Allow()
  colorToken?: unknown;

  @Allow()
  hideAfterMs?: unknown;
}

/** `stage:setEffects`, a partial patch: speed, blackout and the effect
 *  settings keyed by effect id (contract 7.6). `isImmediate` comes from
 *  `VjRemoteCommandPayloadDto`. */
export class VjSetEffectsPayloadDto extends VjRemoteCommandPayloadDto {
  @Allow()
  speed?: unknown;

  @Allow()
  isBlackout?: unknown;

  @Allow()
  settings?: unknown;
}

/** `stage:setStrobe`. `isImmediate` comes from `VjRemoteCommandPayloadDto`. */
export class VjSetStrobePayloadDto extends VjRemoteCommandPayloadDto {
  @Allow()
  isStrobing?: unknown;
}

/** `stage:setShuffle`, a partial patch. The beat count follows `tempo.bpm`. */
export class VjSetShufflePayloadDto extends VjRemoteCommandPayloadDto {
  @Allow()
  isOn?: unknown;

  @Allow()
  intervalKind?: unknown;

  @Allow()
  intervalValue?: unknown;

  @Allow()
  source?: unknown;

  @Allow()
  excludedClipIds?: unknown;
}

/** `stage:setTempo`, a partial patch (contract 7.6). */
export class VjSetTempoPayloadDto extends VjRemoteCommandPayloadDto {
  @Allow()
  bpm?: unknown;

  @Allow()
  downbeatAt?: unknown;

  @Allow()
  quantize?: unknown;

  @Allow()
  source?: unknown;
}

/** `stage:setMix`, a partial patch of the mix layer. */
export class VjSetMixPayloadDto extends VjRemoteCommandPayloadDto {
  @Allow()
  clipId?: unknown;

  @Allow()
  amount?: unknown;

  @Allow()
  blendMode?: unknown;
}

/** `stage:swapMix`: the stamp only. */
export class VjSwapMixPayloadDto extends VjRemoteCommandPayloadDto {}

/** `stage:setScreenOverride`: one screen's override, or null to remove it. */
export class VjSetScreenOverridePayloadDto extends VjRemoteCommandPayloadDto {
  @Allow()
  screenId?: unknown;

  @Allow()
  override?: unknown;
}

/** `screen:identify`: an unstamped remote frame. `screenId` null identifies
 *  every connected screen. */
export class VjScreenIdentifyPayloadDto {
  @Allow()
  screenId?: unknown;
}

/** `screens:setRenderMode`: an unstamped remote frame. Any `mode` value passes
 *  the pipe; the gateway answers `vj_render_mode_invalid` for a bad one. */
export class VjSetRenderModePayloadDto {
  @Allow()
  mode?: unknown;
}

/** `stage:resetLook`. `isImmediate` comes from `VjRemoteCommandPayloadDto`. */
export class VjResetLookPayloadDto extends VjRemoteCommandPayloadDto {}

/** `stage:recallScene`. */
export class VjRecallScenePayloadDto extends VjRemoteCommandPayloadDto {
  @Allow()
  sceneId?: unknown;
}

/** `stage:setlistSelect`: index null arms the set list without recalling. */
export class VjSetlistSelectPayloadDto extends VjRemoteCommandPayloadDto {
  @Allow()
  setlistId?: unknown;

  @Allow()
  index?: unknown;
}

/** `stage:setlistNext` and `stage:setlistPrevious`: the stamp only. */
export class VjSetlistStepPayloadDto extends VjRemoteCommandPayloadDto {}

/** `stage:setCountdown`, a partial patch: `targetAt` or `durationMs`. */
export class VjSetCountdownPayloadDto extends VjRemoteCommandPayloadDto {
  @Allow()
  isVisible?: unknown;

  @Allow()
  targetAt?: unknown;

  @Allow()
  durationMs?: unknown;

  @Allow()
  label?: unknown;
}

/** `stage:setLogo`, a partial patch. */
export class VjSetLogoPayloadDto extends VjRemoteCommandPayloadDto {
  @Allow()
  isVisible?: unknown;

  @Allow()
  corner?: unknown;
}

/** `stage:setEventCard`, a partial patch. */
export class VjSetEventCardPayloadDto extends VjRemoteCommandPayloadDto {
  @Allow()
  isVisible?: unknown;

  @Allow()
  kind?: unknown;
}

/**
 * `clock:sync`: the payload is `{}` (contract 7.3). class-validator refuses
 * an instance whose class declares no rule (`forbidUnknownValues` is on by
 * default), which would refuse `{}` too. This class declares one guard rule
 * that only an absent value passes: `{}` passes, and any key a client sends
 * still meets the pipe's refusal.
 */
export class VjClockSyncPayloadDto {
  @Equals(undefined)
  absentGuard?: undefined;
}

/** `screen:advance`: the lead screen's shuffle report. */
export class VjScreenAdvancePayloadDto {
  @Allow()
  expectedClipSequence?: unknown;

  @Allow()
  clipId?: unknown;
}

/** `screen:status`: a screen's fullscreen flag, preload report and the v2
 *  health, next clip and mic reports (contract 7.9). */
export class VjScreenStatusPayloadDto {
  @Allow()
  isFullscreen?: unknown;

  @Allow()
  preload?: unknown;

  @Allow()
  health?: unknown;

  @Allow()
  nextClipId?: unknown;

  @Allow()
  mic?: unknown;
}
