-- Pin each running Learning sync to the canonical, role-separated URL policy
-- used when its lease was acquired. Only the SHA-256 proof is persisted.

ALTER TABLE learning_sync_runs ADD COLUMN url_policy_fingerprint BLOB CHECK (
  url_policy_fingerprint IS NULL OR (
    typeof(url_policy_fingerprint) = 'blob' AND length(url_policy_fingerprint) = 32
  )
);
