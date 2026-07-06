import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity('company_team_members')
@Unique('UQ_company_team_members', ['companyId', 'userId'])
export class CompanyTeamMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_company_team_members_company_id')
  @Column({ type: 'uuid' })
  companyId: string;

  @Index('IDX_company_team_members_user_id')
  @Column({ type: 'uuid' })
  userId: string;
}
