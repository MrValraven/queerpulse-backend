import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { StudioPlaylist } from './studio-playlist.entity';

/** How a member came to edit a playlist. */
export enum StudioPlaylistEditorSource {
  /** An invited connection of the owner, on a member-credited playlist. */
  MemberInvite = 'member_invite',
  /** A co-owner of the credit persona the owner picked. Created active. */
  PersonaCoOwner = 'persona_co_owner',
}

/**
 * `invited` and `active` are the live states: they open the playlist to the
 * member and count toward `STUDIO_LIMITS.playlistEditorsMax`. Only `active`
 * edits. The other three record how a seat ended, so a re-invite reuses the
 * row (`UQ_studio_playlist_editors_playlist_user`).
 */
export enum StudioPlaylistEditorStatus {
  Invited = 'invited',
  Active = 'active',
  Declined = 'declined',
  Revoked = 'revoked',
  Left = 'left',
}

export const LIVE_STUDIO_PLAYLIST_EDITOR_STATUSES: readonly StudioPlaylistEditorStatus[] =
  [StudioPlaylistEditorStatus.Invited, StudioPlaylistEditorStatus.Active];

/**
 * Collaborative playlists: one member's seat on one Studio playlist, shaped
 * like `listing_co_managers`. The owner stays `studio_playlists.user_id`; the
 * service keeps the owner out of this table.
 *
 * PRIVATE. No public response carries a field of this table. The owner and
 * active editors read the roster; an invitee reads their own invitation.
 *
 * Foreign keys: the playlist and the member cascade (a seat on a playlist
 * that is gone, or held by an erased account, grants nothing); the inviter
 * sets null. Migration `1833100100000-AddStudioPlaylistEditors`.
 */
@Entity('studio_playlist_editors')
@Unique('UQ_studio_playlist_editors_playlist_user', ['playlistId', 'userId'])
@Index('IDX_studio_playlist_editors_user_status', ['userId', 'status'])
@Check(
  'CHK_studio_playlist_editors_persona_source',
  `"source" <> 'persona_co_owner' OR "status" NOT IN ('invited', 'declined')`,
)
export class StudioPlaylistEditor {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_playlist_editors',
  })
  id!: string;

  @Column({ type: 'uuid' })
  playlistId!: string;

  @ManyToOne(() => StudioPlaylist, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'playlist_id',
    foreignKeyConstraintName: 'FK_studio_playlist_editors_playlist',
  })
  playlist?: StudioPlaylist;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_studio_playlist_editors_user',
  })
  user?: User;

  /** The owner who sent the current invitation or pick. */
  @Column({ type: 'uuid', nullable: true })
  invitedByUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'invited_by_user_id',
    foreignKeyConstraintName: 'FK_studio_playlist_editors_invited_by',
  })
  invitedBy?: User | null;

  @Column({
    type: 'enum',
    enum: StudioPlaylistEditorSource,
    enumName: 'studio_playlist_editors_source_enum',
  })
  source!: StudioPlaylistEditorSource;

  @Column({
    type: 'enum',
    enum: StudioPlaylistEditorStatus,
    enumName: 'studio_playlist_editors_status_enum',
    default: StudioPlaylistEditorStatus.Invited,
  })
  status!: StudioPlaylistEditorStatus;

  /** Rewritten on a re-invite, so it describes the current seat. */
  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  invitedAt!: Date;

  /** Set on accept, and at creation for a persona co-owner pick. */
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  acceptedAt!: Date | null;

  /** Set when the seat ends as declined, revoked or left. */
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  endedAt!: Date | null;
}
