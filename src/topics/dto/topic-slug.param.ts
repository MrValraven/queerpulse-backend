import { Matches, MaxLength } from 'class-validator';

/**
 * The `:slug` path parameter on the follow/unfollow routes.
 *
 * Topics are frontend-derived and `topic_follows` deliberately carries no FK
 * to a topics table, so nothing validated this at all: `POST
 * /topics/<anything>/follow` inserted a row for any string of any length
 * (BE-COM-35). A shape check is the strongest bound available without
 * coupling this module to the topics registry, and it is enough to stop
 * arbitrary junk (and oversized values) from reaching the table.
 */
export class TopicSlugParam {
  @MaxLength(64)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must be a lowercase, hyphen-separated topic slug',
  })
  slug!: string;
}
