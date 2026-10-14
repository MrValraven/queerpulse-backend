import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { STUDIO_LIMITS } from '../studio.constants';
import { isPresentValue, trimStringValue } from './create-studio-release.dto';
import {
  HasChapterTimeline,
  HasNonDecreasingTimes,
  IsMeasurementOrNull,
  IsPairedWith,
  roundMeasurementValue,
} from './studio-track-listening.validators';

export class StudioCreditDto {
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.creditFieldMaxLength)
  name!: string;

  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.creditFieldMaxLength)
  role!: string;
}

/** Studio listening: one timed lyric line. An empty text is an
 *  instrumental gap. */
export class StudioSyncedLyricLineDto {
  @IsInt()
  @Min(0)
  @Max(STUDIO_LIMITS.syncedLyricMaxMilliseconds)
  ms!: number;

  @Transform(trimStringValue)
  @IsString()
  @MaxLength(STUDIO_LIMITS.syncedLyricTextMaxLength)
  text!: string;
}

/** Studio listening: one chapter. The service checks `startSeconds` against
 *  the stored duration; a blank or absent artist is stored as null. */
export class StudioChapterDto {
  @IsInt()
  @Min(0)
  startSeconds!: number;

  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.chapterTitleMaxLength)
  title!: string;

  @IsOptional()
  @Transform(trimStringValue)
  @IsString()
  @MaxLength(STUDIO_LIMITS.chapterArtistMaxLength)
  artist?: string | null;
}

/** Studio artist kinds: one credited source of an edit, a lip-sync mix or a
 *  mix. The service refuses sources on other release types. */
export class StudioSourceDto {
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.sourceFieldMaxLength)
  title!: string;

  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.sourceFieldMaxLength)
  artist!: string;
}

// PATCH semantics, as in `UpdateStudioReleaseDto`. `credits` replaces the
// whole ordered list. Lyrics keep their own whitespace (line breaks matter).
// Studio listening (QUEERPULSE-STUDIO-LISTENING-CONTRACT-2026-10-13.md A.5):
// each of the five listening fields is left alone when omitted and cleared
// by null; the loudness pair is sent together. Studio artist kinds add
// `notes` and `sources`.
export class UpdateStudioTrackDto {
  @ValidateIf(isPresentValue)
  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.trackTitleMaxLength)
  title?: string;

  @ValidateIf(isPresentValue)
  @IsArray()
  @ArrayMaxSize(STUDIO_LIMITS.creditsMaxRows)
  @ValidateNested({ each: true })
  @Type(() => StudioCreditDto)
  credits?: StudioCreditDto[];

  // Studio artist kinds: a podcast or spoken word transcript runs to 60000
  // characters; the service holds every other format to 10000.
  @IsOptional()
  @IsString()
  @MaxLength(STUDIO_LIMITS.lyricsMaxLengthLong)
  lyrics?: string | null;

  /** Studio artist kinds: show notes of a podcast episode; null clears. */
  @IsOptional()
  @IsString()
  @MaxLength(STUDIO_LIMITS.notesMaxLength)
  notes?: string | null;

  /** Studio artist kinds: the credited sources, replacing the whole list;
   *  an empty list clears and null is refused. */
  @ValidateIf(isPresentValue)
  @IsArray()
  @ArrayMaxSize(STUDIO_LIMITS.sourcesMaxRows)
  @ValidateNested({ each: true })
  @Type(() => StudioSourceDto)
  sources?: StudioSourceDto[];

  @ValidateIf(isPresentValue)
  @IsBoolean()
  isExplicit?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(STUDIO_LIMITS.waveformPeakCount)
  @ArrayMaxSize(STUDIO_LIMITS.waveformPeakCount)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(STUDIO_LIMITS.waveformPeakMax, { each: true })
  waveformPeaks?: number[] | null;

  @ValidateIf(isPresentValue)
  @Transform(roundMeasurementValue)
  @IsPairedWith('peakDb')
  @IsMeasurementOrNull(
    STUDIO_LIMITS.loudnessLufsMin,
    STUDIO_LIMITS.loudnessLufsMax,
  )
  loudnessLufs?: number | null;

  @ValidateIf(isPresentValue)
  @Transform(roundMeasurementValue)
  @IsPairedWith('loudnessLufs')
  @IsMeasurementOrNull(STUDIO_LIMITS.peakDbMin, STUDIO_LIMITS.peakDbMax)
  peakDb?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(STUDIO_LIMITS.syncedLyricLinesMax)
  @ValidateNested({ each: true })
  @Type(() => StudioSyncedLyricLineDto)
  @HasNonDecreasingTimes()
  syncedLyrics?: StudioSyncedLyricLineDto[] | null;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(STUDIO_LIMITS.chaptersMax)
  @ValidateNested({ each: true })
  @Type(() => StudioChapterDto)
  @HasChapterTimeline()
  chapters?: StudioChapterDto[] | null;
}
