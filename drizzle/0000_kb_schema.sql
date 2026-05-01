CREATE TABLE IF NOT EXISTS `kb_meta` (
  `key` TEXT PRIMARY KEY NOT NULL,
  `value` TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `kb_entries` (
  `key` TEXT PRIMARY KEY NOT NULL,
  `abs_path` TEXT NOT NULL,
  `rel_path` TEXT NOT NULL,
  `source_dir` TEXT NOT NULL,
  `mtime` INTEGER NOT NULL,
  `vector` TEXT NOT NULL,
  `excerpt` TEXT NOT NULL,
  `heading` TEXT NOT NULL,
  `chunk_index` INTEGER NOT NULL
);