import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum BoardResponseKind {
  /** "I can help with this" against a looking post, or "I want this" against
   *  an offering post. Notifies the post owner. */
  Help = 'help',
  /** A board-scoped hello, following the flatmate say-hello precedent. */
  Hello = 'hello',
}

@Entity('board_post_responses')
// One member counts once per post per kind, so a repeat response is a no-op
// the API reports as a conflict rather than inflating a count.
@Index(
  'UQ_board_post_responses_post_responder_kind',
  ['postId', 'responderId', 'kind'],
  { unique: true },
)
export class BoardPostResponse {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_board_post_responses_post_id')
  @Column({ type: 'uuid' })
  postId!: string;

  @Index('IDX_board_post_responses_responder_id')
  @Column({ type: 'uuid' })
  responderId!: string;

  @Column({
    type: 'enum',
    enum: BoardResponseKind,
    enumName: 'board_post_responses_kind_enum',
  })
  kind!: BoardResponseKind;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
