import { readFileSync } from 'fs';
import { join } from 'path';
import { getMetadataArgsStorage } from 'typeorm';
import { VjClip } from './vj-clip.entity';
import { VjPack } from './vj-pack.entity';
import { VjScene } from './vj-scene.entity';
import { VjSetlistItem } from './vj-setlist-item.entity';
import { VjSetlist } from './vj-setlist.entity';

const V2_ENTITY_CLASSES = [VjClip, VjPack, VjScene, VjSetlist, VjSetlistItem];

/** The v2 migration source, read once so each CHECK can be matched against it. */
const MIGRATION_SOURCE = readFileSync(
  join(__dirname, '../../migrations/1839500000000-AddVjV2.ts'),
  'utf8',
);

/** The sequences migration source, read once so its CHECKs and indexes can be matched. */
const SEQUENCES_MIGRATION_SOURCE = readFileSync(
  join(__dirname, '../../migrations/1840200000000-AddVjSequences.ts'),
  'utf8',
);

const columnOf = (target: object, propertyName: string) =>
  getMetadataArgsStorage().columns.find(
    (column) =>
      column.target === target && column.propertyName === propertyName,
  );

const relationOf = (target: object, propertyName: string) =>
  getMetadataArgsStorage().relations.find(
    (relation) =>
      relation.target === target && relation.propertyName === propertyName,
  );

const indexNamed = (indexName: string) =>
  getMetadataArgsStorage().indices.find((index) => index.name === indexName);

describe('VJ v2 entities', () => {
  it('declares every v2 column with the contract types and defaults', () => {
    expect(columnOf(VjClip, 'isFavorite')?.options).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(columnOf(VjClip, 'defaultSpeed')?.options).toMatchObject({
      type: 'double precision',
      default: 1,
    });
    expect(columnOf(VjClip, 'loopInMs')?.options).toMatchObject({
      type: 'integer',
      nullable: true,
    });
    expect(columnOf(VjClip, 'loopOutMs')?.options).toMatchObject({
      type: 'integer',
      nullable: true,
    });
    expect(columnOf(VjClip, 'loopMode')?.options).toMatchObject({
      type: 'varchar',
      length: 10,
      default: 'loop',
    });
    expect(columnOf(VjClip, 'previewStorageKey')?.options).toMatchObject({
      type: 'varchar',
      length: 200,
      nullable: true,
    });
    expect(columnOf(VjPack, 'eventId')?.options).toMatchObject({
      type: 'uuid',
      nullable: true,
    });
    expect(columnOf(VjScene, 'look')?.options.type).toBe('jsonb');
    expect(columnOf(VjScene, 'name')?.options).toMatchObject({
      type: 'varchar',
      length: 60,
    });
    expect(columnOf(VjSetlist, 'name')?.options).toMatchObject({
      type: 'varchar',
      length: 60,
    });
    expect(columnOf(VjSetlistItem, 'sceneId')?.options.type).toBe('uuid');
    expect(columnOf(VjSetlistItem, 'setlistId')?.options.type).toBe('uuid');
  });

  it('declares every sequences column with the contract types and defaults', () => {
    expect(columnOf(VjSetlist, 'isLooping')?.options).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(columnOf(VjSetlist, 'stepDurationKind')?.options).toMatchObject({
      type: 'varchar',
      length: 10,
      default: 'seconds',
    });
    expect(columnOf(VjSetlist, 'stepDurationValue')?.options).toMatchObject({
      type: 'integer',
      default: 8,
    });
    expect(columnOf(VjSetlistItem, 'kind')?.options).toMatchObject({
      type: 'varchar',
      length: 10,
      default: 'scene',
    });
    expect(columnOf(VjSetlistItem, 'sceneId')?.options).toMatchObject({
      type: 'uuid',
      nullable: true,
    });
    expect(columnOf(VjSetlistItem, 'clipId')?.options).toMatchObject({
      type: 'uuid',
      nullable: true,
    });
    expect(columnOf(VjSetlistItem, 'durationKind')?.options).toMatchObject({
      type: 'varchar',
      length: 10,
      nullable: true,
    });
    expect(columnOf(VjSetlistItem, 'durationValue')?.options).toMatchObject({
      type: 'integer',
      nullable: true,
    });
  });

  it('maps the three new tables', () => {
    const tableNames = getMetadataArgsStorage()
      .tables.filter((table) =>
        [VjScene, VjSetlist, VjSetlistItem].includes(
          table.target as typeof VjScene,
        ),
      )
      .map((table) => table.name)
      .sort();
    expect(tableNames).toEqual([
      'vj_scenes',
      'vj_setlist_items',
      'vj_setlists',
    ]);
  });

  it('names no column', () => {
    const columns = getMetadataArgsStorage().columns.filter((column) =>
      V2_ENTITY_CLASSES.includes(column.target as typeof VjClip),
    );
    expect(columns.length).toBeGreaterThan(30);
    for (const column of columns) {
      expect(column.options.name).toBeUndefined();
    }
  });

  it('carries each CHECK with the migration SQL', () => {
    const expectedCheckNames = [
      'CHK_vj_clips_default_speed',
      'CHK_vj_clips_loop_mode',
      'CHK_vj_clips_loop_points',
      'CHK_vj_clips_preview_storage_key',
      'CHK_vj_scenes_name',
      'CHK_vj_scenes_position',
      'CHK_vj_scenes_look',
      'CHK_vj_setlists_name',
      'CHK_vj_setlists_position',
      'CHK_vj_setlist_items_position',
    ];
    const checks = getMetadataArgsStorage().checks.filter((check) =>
      V2_ENTITY_CLASSES.includes(check.target as typeof VjClip),
    );
    for (const checkName of expectedCheckNames) {
      const check = checks.find((candidate) => candidate.name === checkName);
      expect(check).toBeDefined();
      expect(MIGRATION_SOURCE).toContain(
        `"${checkName}" CHECK (${check?.expression ?? ''})`,
      );
    }
  });

  it('carries each sequences CHECK with the migration SQL', () => {
    const expectedCheckNames = [
      'CHK_vj_setlists_step_duration',
      'CHK_vj_setlist_items_kind',
      'CHK_vj_setlist_items_duration',
    ];
    const checks = getMetadataArgsStorage().checks.filter((check) =>
      V2_ENTITY_CLASSES.includes(check.target as typeof VjClip),
    );
    for (const checkName of expectedCheckNames) {
      const check = checks.find((candidate) => candidate.name === checkName);
      expect(check).toBeDefined();
      expect(SEQUENCES_MIGRATION_SOURCE).toContain(
        `"${checkName}" CHECK (${check?.expression ?? ''})`,
      );
    }
  });

  it('keeps the preview key unique', () => {
    const unique = getMetadataArgsStorage().uniques.find(
      (candidate) =>
        candidate.target === VjClip &&
        candidate.name === 'UQ_vj_clips_preview_storage_key',
    );
    expect(unique?.columns).toEqual(['previewStorageKey']);
    expect(MIGRATION_SOURCE).toContain(
      `"UQ_vj_clips_preview_storage_key" UNIQUE ("preview_storage_key")`,
    );
  });

  it('sets null on erasure and on pack or event delete', () => {
    expect(relationOf(VjScene, 'createdBy')?.options.onDelete).toBe('SET NULL');
    expect(relationOf(VjSetlist, 'createdBy')?.options.onDelete).toBe(
      'SET NULL',
    );
    expect(relationOf(VjScene, 'pack')?.options.onDelete).toBe('SET NULL');
    expect(relationOf(VjPack, 'event')?.options.onDelete).toBe('SET NULL');
    expect(relationOf(VjSetlistItem, 'setlist')?.options.onDelete).toBe(
      'CASCADE',
    );
    expect(relationOf(VjSetlistItem, 'scene')?.options.onDelete).toBe(
      'CASCADE',
    );
    expect(relationOf(VjSetlistItem, 'scene')?.options.nullable).toBe(true);
    expect(relationOf(VjSetlistItem, 'clip')?.options.onDelete).toBe('CASCADE');
    expect(relationOf(VjSetlistItem, 'clip')?.options.nullable).toBe(true);

    const joinNames = getMetadataArgsStorage()
      .joinColumns.filter((joinColumn) =>
        V2_ENTITY_CLASSES.includes(joinColumn.target as typeof VjClip),
      )
      .map((joinColumn) => joinColumn.foreignKeyConstraintName);
    expect(joinNames).toEqual(
      expect.arrayContaining([
        'FK_vj_packs_event',
        'FK_vj_scenes_pack',
        'FK_vj_scenes_created_by_user',
        'FK_vj_setlists_created_by_user',
        'FK_vj_setlist_items_setlist',
        'FK_vj_setlist_items_scene',
        'FK_vj_setlist_items_clip',
      ]),
    );
  });

  it('declares the partial indexes', () => {
    expect(indexNamed('IDX_vj_packs_event_id')?.where).toBe(
      '"event_id" IS NOT NULL',
    );
    expect(indexNamed('IDX_vj_scenes_pack_id')?.where).toBe(
      '"pack_id" IS NOT NULL',
    );
    expect(indexNamed('IDX_vj_scenes_created_by_user_id')?.where).toBe(
      '"created_by_user_id" IS NOT NULL',
    );
    expect(indexNamed('IDX_vj_setlists_created_by_user_id')?.where).toBe(
      '"created_by_user_id" IS NOT NULL',
    );
    expect(indexNamed('IDX_vj_setlist_items_clip_id')?.where).toBe(
      '"clip_id" IS NOT NULL',
    );
    expect(SEQUENCES_MIGRATION_SOURCE).toContain(
      `CREATE INDEX "IDX_vj_setlist_items_clip_id" ON "vj_setlist_items" ("clip_id") WHERE "clip_id" IS NOT NULL`,
    );
    for (const indexName of [
      'IDX_vj_packs_event_id',
      'IDX_vj_scenes_pack_id',
      'IDX_vj_scenes_created_by_user_id',
      'IDX_vj_setlists_created_by_user_id',
    ]) {
      expect(MIGRATION_SOURCE).toMatch(
        new RegExp(
          `CREATE INDEX "${indexName}" ON "vj_\\w+" \\("\\w+"\\) WHERE "\\w+" IS NOT NULL`,
        ),
      );
    }
  });
});
