import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum BoardKind {
  Looking = 'looking',
  Offering = 'offering',
}

@Entity('board_posts')
@Index('UQ_board_posts_user_slug', ['userId', 'slug'], { unique: true })
export class BoardPost {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_board_posts_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({
    type: 'enum',
    enum: BoardKind,
    enumName: 'board_posts_kind_enum',
  })
  kind: BoardKind;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'varchar' })
  slug: string;

  @Column({ type: 'int', default: 0 })
  position: number;
}
