import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum ShapingKind {
  Film = 'film',
  Book = 'book',
  Song = 'song',
  Moment = 'moment',
}

@Entity('shapings')
@Index('UQ_shapings_user_kind', ['userId', 'kind'], { unique: true })
export class Shaping {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_shapings_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({
    type: 'enum',
    enum: ShapingKind,
    enumName: 'shapings_kind_enum',
  })
  kind: ShapingKind;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text' })
  note: string;
}
