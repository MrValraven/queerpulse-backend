import 'dotenv/config';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { Activity, ActivityKind } from '../profiles/entities/activity.entity';
import { BoardPost, BoardKind } from '../profiles/entities/board-post.entity';
import { Group } from '../profiles/entities/group.entity';
import { GroupMembership } from '../profiles/entities/group-membership.entity';
import { Shaping, ShapingKind } from '../profiles/entities/shaping.entity';
import { Skill } from '../profiles/entities/skill.entity';

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
  // Guard: the seed inserts fixture members and must never touch a production
  // database. Refuse to run when NODE_ENV signals production.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run the seed with NODE_ENV=production. The seed is for local/dev fixtures only.',
    );
  }

  const dataSource = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    entities: [
      User,
      Profile,
      Skill,
      BoardPost,
      Shaping,
      Activity,
      Group,
      GroupMembership,
    ],
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
  });
  await dataSource.initialize();
  try {
    await dataSource.transaction(async (manager) => {
      const users = manager.getRepository(User);
      const profiles = manager.getRepository(Profile);

      const groupRepo = manager.getRepository(Group);
      let devsGroup = await groupRepo.findOne({
        where: { slug: 'queer-devs-lisbon' },
      });
      if (!devsGroup) {
        devsGroup = await groupRepo.save(
          groupRepo.create({
            slug: 'queer-devs-lisbon',
            name: 'Queer Devs Lisbon',
          }),
        );
      }

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

        if (m.slug === 'tomas-mendes') {
          await manager.getRepository(Profile).update(
            { userId: user.id },
            {
              verified: true,
              now: 'Illustrating a zine about the neighbourhood.',
              joinedAt: new Date('2024-03-01T00:00:00.000Z'),
            },
          );
          await manager.getRepository(Skill).save([
            manager.getRepository(Skill).create({
              userId: user.id,
              name: 'Illustration',
              meta: 'Available · ink, risograph',
              position: 0,
            }),
          ]);
          await manager.getRepository(BoardPost).save([
            manager.getRepository(BoardPost).create({
              userId: user.id,
              kind: BoardKind.Offering,
              title: 'Cover art for community zines',
              slug: 'zine-covers',
              position: 0,
            }),
          ]);
          await manager.getRepository(Shaping).save([
            manager.getRepository(Shaping).create({
              userId: user.id,
              kind: ShapingKind.Film,
              title: 'Paris Is Burning',
              note: 'Chosen family is a craft.',
            }),
          ]);
          await manager.getRepository(Activity).save([
            manager.getRepository(Activity).create({
              userId: user.id,
              kind: ActivityKind.Event,
              title: "RSVP'd to Queer Poetry Night",
              sub: 'Anjos · Thursday',
              toLink: '/gatherings/queer-poetry-night',
              occurredAt: new Date('2026-06-20T18:00:00.000Z'),
            }),
          ]);
          await manager.getRepository(GroupMembership).save(
            manager.getRepository(GroupMembership).create({
              userId: user.id,
              groupId: devsGroup.id,
              role: 'Member',
            }),
          );
        }

        console.log(`Seeded member ${m.slug}`);
      }
    });

    console.log('Seed complete.');
  } finally {
    await dataSource.destroy();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
