import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity('event_cohosts')
@Unique('UQ_event_cohosts', ['eventId', 'userId'])
export class EventCohost {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_event_cohosts_event_id')
  @Column({ type: 'uuid' })
  eventId: string;

  @Index('IDX_event_cohosts_user_id')
  @Column({ type: 'uuid' })
  userId: string;
}
