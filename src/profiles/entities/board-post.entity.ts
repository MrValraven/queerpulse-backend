import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum BoardKind {
  Looking = 'looking',
  Offering = 'offering',
}

export enum BoardPostStatus {
  Open = 'open',
  Closed = 'closed',
}

@Entity('board_posts')
@Index('UQ_board_posts_user_slug', ['userId', 'slug'], { unique: true })
export class BoardPost {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_board_posts_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: BoardKind,
    enumName: 'board_posts_kind_enum',
  })
  kind!: BoardKind;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'varchar' })
  slug!: string;

  @Column({ type: 'int', default: 0 })
  position!: number;

  @Column({
    type: 'enum',
    enum: BoardPostStatus,
    enumName: 'board_posts_status_enum',
    default: BoardPostStatus.Open,
  })
  status!: BoardPostStatus;

  @Column({ type: 'text', nullable: true })
  closedNote!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  // Kind-dependent (looking=+30d, offering=+90d from creation), computed in
  // application code at insert time — see ProfilesService.replaceBoard.
  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
