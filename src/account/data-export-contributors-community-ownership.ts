import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DataExportContribution } from './data-export-contributor';

interface CommunityOwnershipOfferExportRow {
  id: string;
  community_id: string;
  community_slug: string;
  community_name: string;
  side: 'received' | 'sent';
  other_party_user_id: string | null;
  status: string;
  offered_at: Date;
  expires_at: Date;
  responded_at: Date | null;
}

/**
 * `communities` -> `communityOwnershipOffers` (PRD-514): every ownership
 * offer the member received or made, with where it stands. One row per offer
 * and side. The other party is named by account id only, matching how the
 * archive treats people who are not the member: the member's own record says
 * that an offer passed between them and someone, and the platform's display
 * profile of that person is theirs to export. Raw SQL through the
 * `DataSource`, so `AccountModule` needs no `forFeature` registration.
 */
@Injectable()
export class CommunityOwnershipOffersExportContributor implements DataExportContribution {
  readonly category = 'communities';
  readonly archiveKey = 'communityOwnershipOffers';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows: CommunityOwnershipOfferExportRow[] =
      await this.dataSource.query(
        `SELECT "o"."id" AS "id",
              "c"."id" AS "community_id",
              "c"."slug" AS "community_slug",
              "c"."name" AS "community_name",
              CASE WHEN "o"."offeree_id" = $1 THEN 'received' ELSE 'sent' END AS "side",
              CASE WHEN "o"."offeree_id" = $1 THEN "o"."offered_by_user_id" ELSE "o"."offeree_id" END AS "other_party_user_id",
              "o"."status" AS "status",
              "o"."offered_at" AS "offered_at",
              "o"."expires_at" AS "expires_at",
              "o"."responded_at" AS "responded_at"
         FROM "community_ownership_offers" "o"
        INNER JOIN "communities" "c" ON "c"."id" = "o"."community_id"
        WHERE "o"."offeree_id" = $1 OR "o"."offered_by_user_id" = $1
        ORDER BY "o"."offered_at" ASC, "o"."id" ASC`,
        [userId],
      );
    return rows.map((row) => ({
      id: row.id,
      communityId: row.community_id,
      communitySlug: row.community_slug,
      communityName: row.community_name,
      side: row.side,
      otherPartyUserId: row.other_party_user_id,
      status: row.status,
      offeredAt: row.offered_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      respondedAt: row.responded_at ? row.responded_at.toISOString() : null,
    }));
  }
}
