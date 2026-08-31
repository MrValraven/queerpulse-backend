import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ArticleBlock } from './magazine-article.entity';

/**
 * A point-in-time snapshot of a `MagazineArticle`'s `blocks` (Magazine Desk
 * Phase 7, Task E1 — the editor's VersionsRail: snapshot + restore + diff).
 * Written on three occasions: automatically when a writer files a draft
 * (`MagazinePieceService.fileDraft`, label `"Filed draft"`), on an explicit
 * editor "save version" (`createArticleVersion`, label `"Manual save"` by
 * default), and twice by `restoreArticleVersion` — once for the pre-restore
 * state (`"Before restore"`, so a restore is itself undoable) and once for
 * the restore itself (`"Restored from {date}"`). `blocks` is a deep copy of
 * the article's blocks at snapshot time, never a live reference — a later
 * mutation of the article must never retroactively change a past version.
 */
@Entity('magazine_article_version')
export class MagazineArticleVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_magazine_article_version_article')
  @Column({ type: 'uuid' })
  articleId!: string;

  @Column({ type: 'varchar' })
  label!: string;

  // Already nullable (an automatic snapshot has no human actor); FK-backed as
  // of `AddMagazineDeskAuthorForeignKeys1795810000000` with `ON DELETE SET
  // NULL`, so erasing an editor's account never removes restore points other
  // people still rely on.
  @Index('IDX_magazine_article_version_author_id')
  @Column({ type: 'uuid', nullable: true })
  authorId!: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  blocks!: ArticleBlock[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
