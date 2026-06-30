import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('social_links')
export class SocialLink {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_social_links_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar' })
  platform: string;

  @Column({ type: 'varchar' })
  urlOrHandle: string;

  @Column({ type: 'int', default: 0 })
  position: number;
}
