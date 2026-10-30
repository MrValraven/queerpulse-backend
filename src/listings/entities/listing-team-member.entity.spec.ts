import { getMetadataArgsStorage } from 'typeorm';
import {
  LIVE_LISTING_TEAM_STATUSES,
  ListingTeamInitiator,
  ListingTeamMember,
  ListingTeamMemberStatus,
} from './listing-team-member.entity';

const metadata = getMetadataArgsStorage();

const columnOptions = (propertyName: string): Record<string, unknown> =>
  (metadata.columns.find(
    (column) =>
      column.target === ListingTeamMember &&
      column.propertyName === propertyName,
  )?.options ?? {}) as Record<string, unknown>;

const indexNamed = (name: string) =>
  metadata.indices.find(
    (index) => index.target === ListingTeamMember && index.name === name,
  );

describe('ListingTeamMember entity', () => {
  it('declares the three checks and the four key names the migrations use', () => {
    const checks = metadata.checks.filter(
      (check) => check.target === ListingTeamMember,
    );
    expect(checks).toHaveLength(3);
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'CHK_listing_team_members_position',
          expression: `("status" = 'accepted') = ("position" IS NOT NULL)`,
        }),
        expect.objectContaining({
          name: 'CHK_listing_team_members_one_subject',
          expression: `(("subprofile_id" IS NOT NULL)::int + ("user_id" IS NOT NULL)::int) = 1`,
        }),
        expect.objectContaining({
          name: 'CHK_listing_team_members_member_listing_initiated',
          expression: `"user_id" IS NULL OR "initiated_by" = 'listing'`,
        }),
      ]),
    );
    const keyNames = metadata.joinColumns
      .filter((joinColumn) => joinColumn.target === ListingTeamMember)
      .map((joinColumn) => joinColumn.foreignKeyConstraintName)
      .sort();
    expect(keyNames).toEqual([
      'FK_listing_team_members_listing',
      'FK_listing_team_members_requested_by',
      'FK_listing_team_members_subprofile',
      'FK_listing_team_members_user',
    ]);
  });

  it('maps to the table and the indexes the migration creates', () => {
    expect(
      metadata.tables.find((table) => table.target === ListingTeamMember)?.name,
    ).toBe('listing_team_members');
    expect(indexNamed('UQ_listing_team_members_live_pair')).toEqual(
      expect.objectContaining({
        columns: ['listingId', 'subprofileId'],
        unique: true,
        where: `"status" IN ('pending', 'accepted')`,
      }),
    );
    expect(indexNamed('UQ_listing_team_members_live_member')).toEqual(
      expect.objectContaining({
        columns: ['listingId', 'userId'],
        unique: true,
        where: `"status" IN ('pending', 'accepted')`,
      }),
    );
    expect(indexNamed('IDX_listing_team_members_user_status')).toEqual(
      expect.objectContaining({ columns: ['userId', 'status'] }),
    );
    expect(indexNamed('IDX_listing_team_members_listing_status')).toEqual(
      expect.objectContaining({ columns: ['listingId', 'status'] }),
    );
    expect(indexNamed('IDX_listing_team_members_subprofile_status')).toEqual(
      expect.objectContaining({ columns: ['subprofileId', 'status'] }),
    );
    expect(indexNamed('IDX_listing_team_members_requested_by_user_id')).toEqual(
      expect.objectContaining({ columns: ['requestedByUserId'] }),
    );
  });

  it("stores both enums under the migration's names", () => {
    expect(columnOptions('status')).toEqual(
      expect.objectContaining({
        enumName: 'listing_team_members_status_enum',
        default: ListingTeamMemberStatus.Pending,
      }),
    );
    expect(columnOptions('initiatedBy')).toEqual(
      expect.objectContaining({
        enumName: 'listing_team_members_initiated_by_enum',
      }),
    );
    expect(Object.values(ListingTeamMemberStatus)).toEqual([
      'pending',
      'accepted',
      'declined',
      'cancelled',
      'removed',
      'left',
    ]);
    expect(Object.values(ListingTeamInitiator)).toEqual(['listing', 'persona']);
    expect(LIVE_LISTING_TEAM_STATUSES).toEqual([
      ListingTeamMemberStatus.Pending,
      ListingTeamMemberStatus.Accepted,
    ]);
  });

  it('keeps role label at 40 characters and every column free of an explicit name', () => {
    expect(columnOptions('roleLabel')).toEqual(
      expect.objectContaining({ type: 'varchar', length: 40, nullable: true }),
    );
    const ownColumns = metadata.columns.filter(
      (column) => column.target === ListingTeamMember,
    );
    expect(ownColumns.length).toBeGreaterThan(0);
    for (const column of ownColumns) {
      expect(column.options).not.toHaveProperty('name');
    }
  });

  it('lets either subject be null and cascades the member key on delete', () => {
    expect(columnOptions('subprofileId')).toEqual(
      expect.objectContaining({ type: 'uuid', nullable: true }),
    );
    expect(columnOptions('userId')).toEqual(
      expect.objectContaining({ type: 'uuid', nullable: true }),
    );
    const relation = metadata.relations.find(
      (candidate) =>
        candidate.target === ListingTeamMember &&
        candidate.propertyName === 'user',
    );
    expect(relation?.options).toEqual(
      expect.objectContaining({ onDelete: 'CASCADE' }),
    );
    expect(relation?.options).not.toHaveProperty('onUpdate');
  });

  it('cascades the persona key on update', () => {
    const relation = metadata.relations.find(
      (candidate) =>
        candidate.target === ListingTeamMember &&
        candidate.propertyName === 'subprofile',
    );
    expect(relation?.options).toEqual(
      expect.objectContaining({ onDelete: 'CASCADE', onUpdate: 'CASCADE' }),
    );
  });
});
