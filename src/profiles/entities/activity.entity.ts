import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum ActivityKind {
  Post = 'post',
  Event = 'event',
  Message = 'message',
  Reading = 'reading',
  Edit = 'edit',
  Photo = 'photo',
  Music = 'music',
}

@Entity('activities')
export class Activity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_activities_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({
    type: 'enum',
    enum: ActivityKind,
    enumName: 'activities_kind_enum',
  })
  kind: ActivityKind;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'varchar', nullable: true })
  sub: string | null;

  @Column({ type: 'varchar', nullable: true })
  toLink: string | null;

  @Column({ type: 'timestamptz' })
  occurredAt: Date;
}
