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
  it('declares the position check and the three key names the migration uses', () => {
    expect(
      metadata.checks.find((check) => check.target === ListingTeamMember),
    ).toEqual(
      expect.objectContaining({
        name: 'CHK_listing_team_members_position',
        expression: `("status" = 'accepted') = ("position" IS NOT NULL)`,
      }),
    );
    const keyNames = metadata.joinColumns
      .filter((joinColumn) => joinColumn.target === ListingTeamMember)
      .map((joinColumn) => joinColumn.foreignKeyConstraintName)
      .sort();
    expect(keyNames).toEqual([
      'FK_listing_team_members_listing',
      'FK_listing_team_members_requested_by',
      'FK_listing_team_members_subprofile',
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
