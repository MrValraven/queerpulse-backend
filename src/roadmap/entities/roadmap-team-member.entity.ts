import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One person on the team roster shown in the admin Capacity view — how many
 * hours a week they can give, and whether they're paid or volunteering.
 * `userId` is unique: a member has at most one roster row. No relation to
 * `User` here (see `roadmap-item.entity.ts`'s `ownerId` doc) — the admin
 * service resolves `name` from `users` in a batch query.
 */
@Entity('roadmap_team_members')
export class RoadmapTeamMember {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', unique: true })
  userId!: string;

  @Column()
  role!: string;

  @Column({ type: 'int', default: 0 })
  weeklyCapHours!: number;

  @Column({ default: false })
  paid!: boolean;

  @Column({ type: 'int', default: 0 })
  sortOrder!: number;
}
