import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity('volunteer_opportunity_team')
@Unique('UQ_volunteer_opportunity_team', ['opportunityId', 'userId'])
export class VolunteerOpportunityTeam {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_volunteer_opportunity_team_opportunity_id')
  @Column({ type: 'uuid' })
  opportunityId: string;

  @Index('IDX_volunteer_opportunity_team_user_id')
  @Column({ type: 'uuid' })
  userId: string;
}
