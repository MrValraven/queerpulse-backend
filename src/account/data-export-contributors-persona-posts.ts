import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DataExportContribution } from './data-export-contributor';

interface PersonaPostExportRow {
  persona_name: string;
  body: string;
  link_url: string | null;
  created_at: Date;
  edited_at: Date | null;
}

/**
 * `subprofiles` -> `personaPosts` (Studio v3): the persona posts the member
 * wrote, with the persona's name, the body, the link and both dates. The
 * photo is listed with the member's uploads. Raw SQL through the
 * `DataSource`, so `AccountModule` needs no `forFeature` registration.
 */
@Injectable()
export class PersonaPostsExportContributor implements DataExportContribution {
  readonly category = 'subprofiles';
  readonly archiveKey = 'personaPosts';

  constructor(private readonly dataSource: DataSource) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows: PersonaPostExportRow[] = await this.dataSource.query(
      `SELECT "persona"."display_name" AS "persona_name",
              "post"."body" AS "body",
              "post"."link_url" AS "link_url",
              "post"."created_at" AS "created_at",
              "post"."edited_at" AS "edited_at"
         FROM "subprofile_posts" "post"
        INNER JOIN "subprofiles" "persona" ON "persona"."id" = "post"."subprofile_id"
        WHERE "post"."author_user_id" = $1
        ORDER BY "post"."created_at" ASC, "post"."id" ASC`,
      [userId],
    );
    return rows.map((row) => ({
      personaName: row.persona_name,
      body: row.body,
      linkUrl: row.link_url,
      createdAt: row.created_at.toISOString(),
      editedAt: row.edited_at ? row.edited_at.toISOString() : null,
    }));
  }
}
