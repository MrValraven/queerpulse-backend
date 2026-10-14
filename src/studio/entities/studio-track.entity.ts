import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { StudioRelease } from './studio-release.entity';

export interface StudioCredit {
  name: string;
  role: string;
}

/** Studio listening: one timed lyric line. `ms` is where the line starts;
 *  an empty `text` marks an instrumental gap. */
export interface StudioSyncedLyricLine {
  ms: number;
  text: string;
}

/** Studio listening: one chapter of a track, such as a DJ mix's tracklist. */
export interface StudioChapter {
  startSeconds: number;
  title: string;
  artist: string | null;
}

/** Studio artist kinds: one credited source of an edit, a lip-sync mix or a
 *  mix, as free text. */
export interface StudioSource {
  title: string;
  artist: string;
}

/** `numeric` columns arrive from `pg` as strings; the entity reads numbers. */
export const numericColumnToNumber = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

/**
 * One track of a Studio release. `(release_id, position)` is unique and
 * DEFERRABLE INITIALLY IMMEDIATE, so a reorder or a delete moves every
 * position in one statement and Postgres checks the set at statement end.
 * `audio_key` is unique while set, so one object never backs two tracks.
 * Migration `1830900000000-AddStudio`; the five listening columns and their
 * checks come from `1832500000000-AddStudioListeningFields`.
 * The episode columns (`notes`, `sources`, `published_at`, `followers_notified_at`) come from `1833000100000-AddStudioTrackEpisodeColumns`.
 */
@Entity('studio_tracks')
@Unique('UQ_studio_tracks_release_position', ['releaseId', 'position'], {
  deferrable: 'INITIALLY IMMEDIATE',
})
@Check('CHK_studio_tracks_position', `"position" >= 1`)
@Check(
  'CHK_studio_tracks_waveform_peaks',
  `"waveform_peaks" IS NULL OR (array_ndims("waveform_peaks") = 1 AND cardinality("waveform_peaks") = 200 AND array_position("waveform_peaks", NULL) IS NULL AND 0 <= ALL ("waveform_peaks") AND 255 >= ALL ("waveform_peaks"))`,
)
@Check(
  'CHK_studio_tracks_loudness_lufs',
  `"loudness_lufs" IS NULL OR "loudness_lufs" BETWEEN -70 AND 0`,
)
@Check(
  'CHK_studio_tracks_peak_db',
  `"peak_db" IS NULL OR "peak_db" BETWEEN -60 AND 3`,
)
@Check(
  'CHK_studio_tracks_loudness_pair',
  `("loudness_lufs" IS NULL) = ("peak_db" IS NULL)`,
)
@Check(
  'CHK_studio_tracks_synced_lyrics',
  `"synced_lyrics" IS NULL OR (CASE WHEN jsonb_typeof("synced_lyrics") = 'array' THEN jsonb_array_length("synced_lyrics") BETWEEN 1 AND 500 ELSE false END)`,
)
@Check(
  'CHK_studio_tracks_chapters',
  `"chapters" IS NULL OR (CASE WHEN jsonb_typeof("chapters") = 'array' THEN jsonb_array_length("chapters") BETWEEN 1 AND 100 ELSE false END)`,
)
// Studio artist kinds: sources stay a JSON list of at most 100 rows, notes
// stay within 4000 characters, and a show's published episodes are read
// newest first per show and across shows (the latest-episodes feed).
// Migration `1833000100000-AddStudioTrackEpisodeColumns`.
@Check(
  'CHK_studio_tracks_sources',
  `CASE WHEN jsonb_typeof("sources") = 'array' THEN jsonb_array_length("sources") <= 100 ELSE false END`,
)
@Check(
  'CHK_studio_tracks_notes',
  `"notes" IS NULL OR char_length("notes") <= 4000`,
)
@Index('IDX_studio_tracks_release_published_at', ['releaseId', 'publishedAt'], {
  where: '"published_at" IS NOT NULL',
})
@Index('IDX_studio_tracks_published_at', ['publishedAt', 'id'], {
  where: '"published_at" IS NOT NULL',
})
export class StudioTrack {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_tracks',
  })
  id!: string;

  @Column({ type: 'uuid' })
  releaseId!: string;

  @ManyToOne(() => StudioRelease, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'release_id',
    foreignKeyConstraintName: 'FK_studio_tracks_release',
  })
  release?: StudioRelease;

  @Column({ type: 'smallint' })
  position!: number;

  @Column({ type: 'varchar', length: 120 })
  title!: string;

  @Index('UQ_studio_tracks_audio_key', {
    unique: true,
    where: '"audio_key" IS NOT NULL',
  })
  @Column({ type: 'varchar', nullable: true })
  audioKey!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  audioContentType!: string | null;

  @Column({ type: 'integer', nullable: true })
  audioBytes!: number | null;

  @Column({ type: 'integer', nullable: true })
  durationSeconds!: number | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  credits!: StudioCredit[];

  @Column({ type: 'text', nullable: true })
  lyrics!: string | null;

  @Column({ type: 'boolean', default: false })
  isExplicit!: boolean;

  /** Studio listening: 200 peaks from 0 to 255, measured in the uploader's
   *  browser. Null until measured. */
  @Column({ type: 'smallint', array: true, nullable: true })
  waveformPeaks!: number[] | null;

  /** Integrated loudness (EBU R128), one decimal. Set and cleared together
   *  with `peakDb`. */
  @Column({
    type: 'numeric',
    precision: 4,
    scale: 1,
    nullable: true,
    transformer: numericColumnToNumber,
  })
  loudnessLufs!: number | null;

  /** Sample peak plus 0.5 dB, one decimal. */
  @Column({
    type: 'numeric',
    precision: 4,
    scale: 1,
    nullable: true,
    transformer: numericColumnToNumber,
  })
  peakDb!: number | null;

  @Column({ type: 'jsonb', nullable: true })
  syncedLyrics!: StudioSyncedLyricLine[] | null;

  @Column({ type: 'jsonb', nullable: true })
  chapters!: StudioChapter[] | null;

  /** Studio artist kinds: show notes, written and read on podcast episodes
   *  only. */
  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  /** Studio artist kinds: the songs an edit, a lip-sync mix or a mix uses. */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  sources!: StudioSource[];

  /** Studio artist kinds: when a podcast episode came out. Null on a draft
   *  episode and on every track of another release type. Millisecond
   *  precision: it is the latest-episodes keyset cursor. */
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  publishedAt!: Date | null;

  /** Studio artist kinds: the once-only claim of the episode alert. A show
   *  publish sets it on every episode it carries, so those send nothing. */
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  followersNotifiedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
