import type { DatabaseSync } from 'node:sqlite';
import { imageAnalysisSchema, type ImageAnalysis } from '../shared/schema.js';

export const imageCachePolicy = {
  maxBytes: 100_000_000,
  maxIdleMs: 30 * 86400000,
  cleanupIntervalMs: 3600000,
};

/** SQLite owns durable analyses and bounded, account-scoped QQ/occurrence indexes. No image files. */
export class ImageAnalysisCache {
  constructor(
    private readonly database: DatabaseSync,
    private readonly policy = imageCachePolicy,
  ) {
    database.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS image_analyses (
        account TEXT NOT NULL, digest TEXT NOT NULL, data TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_used INTEGER NOT NULL, PRIMARY KEY(account,digest));
      CREATE INDEX IF NOT EXISTS image_analyses_lru ON image_analyses(last_used);
      CREATE TABLE IF NOT EXISTS image_aliases (
        account TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, last_used INTEGER NOT NULL,
        PRIMARY KEY(account,key), FOREIGN KEY(account,digest) REFERENCES image_analyses(account,digest) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS image_occurrences (
        account TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, last_used INTEGER NOT NULL,
        PRIMARY KEY(account,key), FOREIGN KEY(account,digest) REFERENCES image_analyses(account,digest) ON DELETE CASCADE);`);
  }
  candidate(account: string, key: string): string | undefined {
    const row = this.database
      .prepare('SELECT digest FROM image_aliases WHERE account=? AND key=?')
      .get(account, key);
    return row ? String(row.digest) : undefined;
  }
  occurrence(account: string, key: string): string | undefined {
    const row = this.database
      .prepare('SELECT digest FROM image_occurrences WHERE account=? AND key=?')
      .get(account, key);
    return row ? String(row.digest) : undefined;
  }
  get(account: string, digest: string, now: number): ImageAnalysis | undefined {
    const row = this.database
      .prepare('SELECT data,last_used FROM image_analyses WHERE account=? AND digest=?')
      .get(account, digest);
    if (!row) return;
    if (now - Number(row.last_used) >= this.policy.maxIdleMs) {
      this.database
        .prepare('DELETE FROM image_analyses WHERE account=? AND digest=?')
        .run(account, digest);
      return;
    }
    const analysis = imageAnalysisSchema.parse(JSON.parse(String(row.data)));
    this.database
      .prepare('UPDATE image_analyses SET last_used=? WHERE account=? AND digest=?')
      .run(now, account, digest);
    return analysis;
  }
  save(
    account: string,
    analysis: ImageAnalysis,
    now: number,
    occurrenceKey: string,
    aliasKey: string,
  ): void {
    const value = imageAnalysisSchema.parse(analysis);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          `INSERT INTO image_analyses VALUES(?,?,?,?,?) ON CONFLICT(account,digest)
        DO UPDATE SET data=excluded.data,last_used=excluded.last_used`,
        )
        .run(account, value.sha256, JSON.stringify(value), now, now);
      this.bind(account, value.sha256, occurrenceKey, aliasKey, now);
      this.prune(now);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  bind(
    account: string,
    digest: string,
    occurrenceKey: string,
    aliasKey: string,
    now: number,
  ): void {
    this.database
      .prepare(
        `INSERT INTO image_occurrences VALUES(?,?,?,?) ON CONFLICT(account,key)
      DO UPDATE SET digest=excluded.digest,last_used=excluded.last_used`,
      )
      .run(account, occurrenceKey, digest, now);
    this.database
      .prepare(
        `INSERT INTO image_aliases VALUES(?,?,?,?) ON CONFLICT(account,key)
      DO UPDATE SET digest=excluded.digest,last_used=excluded.last_used`,
      )
      .run(account, aliasKey, digest, now);
  }
  size(): number {
    const row = this.database
      .prepare(
        `SELECT
      COALESCE((SELECT SUM(length(CAST(account AS BLOB))+length(digest)+length(CAST(data AS BLOB))+16) FROM image_analyses),0) +
      COALESCE((SELECT SUM(length(CAST(account AS BLOB))+length(key)+length(digest)+8) FROM image_aliases),0) +
      COALESCE((SELECT SUM(length(CAST(account AS BLOB))+length(key)+length(digest)+8) FROM image_occurrences),0) AS bytes`,
      )
      .get();
    return Number(row?.bytes ?? 0);
  }
  prune(now: number): void {
    this.database
      .prepare('DELETE FROM image_analyses WHERE last_used<=?')
      .run(now - this.policy.maxIdleMs);
    let bytes = this.size();
    while (bytes > this.policy.maxBytes) {
      const oldest = this.database
        .prepare(
          'SELECT account,digest FROM image_analyses ORDER BY last_used,created_at,account,digest LIMIT 1',
        )
        .get();
      if (!oldest) break;
      this.database
        .prepare('DELETE FROM image_analyses WHERE account=? AND digest=?')
        .run(String(oldest.account), String(oldest.digest));
      bytes = this.size();
    }
  }
}
