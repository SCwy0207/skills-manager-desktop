CREATE TABLE IF NOT EXISTS skill_security_scans (
    location_id TEXT PRIMARY KEY,
    revision_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('safe', 'review', 'risky', 'blocked')),
    observed_hash TEXT,
    scanned_files INTEGER NOT NULL,
    scanned_bytes INTEGER NOT NULL,
    skipped_binary_files INTEGER NOT NULL,
    skipped_oversized_files INTEGER NOT NULL,
    skipped_links INTEGER NOT NULL,
    scanned_at INTEGER NOT NULL,
    FOREIGN KEY (location_id) REFERENCES skill_locations(id) ON DELETE CASCADE,
    FOREIGN KEY (revision_id) REFERENCES skill_revisions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_security_scans_revision
    ON skill_security_scans(revision_id);
