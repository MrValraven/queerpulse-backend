import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('work_items')
export class WorkItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_work_items_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar' })
  category: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'varchar' })
  year: string;

  @Column({ type: 'varchar', nullable: true })
  imageUrl: string | null;

  @Column({ type: 'int', default: 0 })
  position: number;
}
