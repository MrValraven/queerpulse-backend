/**
 * One row of the curated starter topic directory.
 *
 * Mirrors the columns `content/entities/topic.entity.ts` actually stores. The
 * counters are deliberately absent: `total_posts` and `follower_count` are
 * maintained by real activity, so the migration inserts them at zero rather
 * than shipping a headline number no post or follow backs up.
 */
export interface TopicSeed {
  tag: string;
  label: string;
  description: string;
  /** Surfaces the crisis-support sidebar card on that topic's page. */
  isCrisisCard: boolean;
}

/**
 * The starter topic directory, shipped so `/topics` and `/topic/:tag` have
 * something real behind them in every environment.
 *
 * WHY THESE FIVE. They are the editorial set the frontend's demo fixture
 * (`queerpulse/src/features/topics/topics.data.tsx`, its `TOPICS` registry)
 * has been showing since the prototype: healthcare, trans, mentalhealth,
 * housing, nightlife. The labels match `useTopics.ts`'s `DEMO_TOPIC_LABELS`
 * so demo mode and live mode name the same topic the same way, and each
 * description is that fixture's JSX `sub` flattened to plain text with its
 * links stripped, exactly as the entity's docstring describes the column.
 *
 * WHY A DATA MIGRATION RATHER THAN THE DEV SEED. `src/database/seed.ts`
 * refuses to run under `NODE_ENV=production`, so seeding there would leave
 * production with the table created and empty: the directory renders its
 * "no topics" empty state and every topic page 404s, while the meganav and
 * global search keep linking to both. `SeedTopics1794701000000` inserts
 * these rows in every environment, and this file stays the single source of
 * the copy so the words cannot drift between the two.
 *
 * ADDING MORE. Past this starter set, topics are an operating decision, so
 * new ones are created through `admin-topics` rather than by editing this
 * file. The migration never runs again.
 */
export const topicsSeed: TopicSeed[] = [
  {
    tag: 'healthcare',
    label: 'Healthcare',
    description:
      'Conversations, resources, recommendations, and warnings about navigating health systems as a queer person in Lisbon. Curated by Trans Hub and Wellbeing.',
    isCrisisCard: false,
  },
  {
    tag: 'trans',
    label: 'Trans',
    description:
      'Everything trans and non-binary life in Lisbon touches: legal name changes, hormones, community, joy. Curated by Trans Hub.',
    isCrisisCard: false,
  },
  {
    tag: 'mentalhealth',
    label: 'Mental health',
    description:
      'Therapy that gets us, peer support, and the honest conversations in between. Curated by Wellbeing. You are not alone here.',
    isCrisisCard: true,
  },
  {
    tag: 'housing',
    label: 'Housing',
    description:
      'Sublets, flatshares, co-ops, and mutual aid for finding somewhere safe to live as a queer person in Lisbon. Real listings, real people, no agencies.',
    isCrisisCard: false,
  },
  {
    tag: 'nightlife',
    label: 'Nightlife',
    description:
      "Where to dance, who's playing, and which rooms actually feel safe after dark. Party listings, venue reviews, and get-home-safe plans, by the people who go.",
    isCrisisCard: false,
  },
];
