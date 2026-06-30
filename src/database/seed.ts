import 'dotenv/config';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

// Representative members for local frontend integration. Replace/extend with the
// prototype's mock members (frontend src/features/members/data/members.ts) as
// needed — the slugs are the integration key.
const MEMBERS: Array<{
  googleId: string;
  email: string;
  status: UserStatus;
  slug: string;
  firstName: string;
  lastName: string;
  pronouns: string | null;
  tagline: string | null;
  location: string | null;
  visibility: ProfileVisibility;
  tags: string[];
  openTo: string[];
}> = [
  {
    googleId: 'seed-tomas',
    email: 'tomas@example.com',
    status: UserStatus.Active,
    slug: 'tomas-mendes',
    firstName: 'Tomás',
    lastName: 'Mendes',
    pronouns: 'he/him',
    tagline: 'Illustrator & zine-maker',
    location: 'Lisbon',
    visibility: ProfileVisibility.Open,
    tags: ['Illustration', 'Print'],
    openTo: ['Collaborations'],
  },
  {
    googleId: 'seed-ana',
    email: 'ana@example.com',
    status: UserStatus.Active,
    slug: 'ana-rocha',
    firstName: 'Ana',
    lastName: 'Rocha',
    pronouns: 'she/her',
    tagline: 'Sound artist',
    location: 'Porto',
    visibility: ProfileVisibility.Network,
    tags: ['Music', 'Performance'],
    openTo: ['Mentoring'],
  },
  {
    googleId: 'seed-noa',
    email: 'noa@example.com',
    status: UserStatus.Active,
    slug: 'noa-silva',
    firstName: 'Noa',
    lastName: 'Silva',
    pronouns: 'they/them',
    tagline: 'Curator',
    location: 'Braga',
    visibility: ProfileVisibility.Open,
    tags: ['Curation'],
    openTo: ['Collaborations', 'Hiring'],
  },
  {
    googleId: 'seed-pending',
    email: 'pending@example.com',
    status: UserStatus.Pending,
    slug: 'sam-pending',
    firstName: 'Sam',
    lastName: 'Costa',
    pronouns: 'she/they',
    tagline: 'New here',
    location: 'Lisbon',
    visibility: ProfileVisibility.Open,
    tags: [],
    openTo: [],
  },
];

async function seed(): Promise<void> {
  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    entities: [User, Profile],
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
  });
  await dataSource.initialize();
  try {
    await dataSource.transaction(async (manager) => {
      const users = manager.getRepository(User);
      const profiles = manager.getRepository(Profile);
      for (const m of MEMBERS) {
        // Idempotent: skip if a user with this googleId already exists.
        const existing = await users.findOne({
          where: { googleId: m.googleId },
        });
        if (existing) {
          continue;
        }
        const user = await users.save(
          users.create({
            googleId: m.googleId,
            email: m.email,
            status: m.status,
            activatedAt: m.status === UserStatus.Active ? new Date() : null,
          }),
        );
        await profiles.save(
          profiles.create({
            userId: user.id,
            slug: m.slug,
            firstName: m.firstName,
            lastName: m.lastName,
            pronouns: m.pronouns,
            tagline: m.tagline,
            location: m.location,
            visibility: m.visibility,
            tags: m.tags,
            openTo: m.openTo,
            avatarUrl: null,
          }),
        );
        // eslint-disable-next-line no-console
        console.log(`Seeded member ${m.slug}`);
      }
    });
    // eslint-disable-next-line no-console
    console.log('Seed complete.');
  } finally {
    await dataSource.destroy();
  }
}

seed().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Seed failed:', err);
  process.exit(1);
});
