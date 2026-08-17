-- PostgreSQL parity for the Learning sync URL-policy proof. Existing historical
-- rows remain nullable; all new application-created runs persist a 32-byte hash.

ALTER TABLE learning_sync_runs ADD COLUMN url_policy_fingerprint bytea
  CHECK (url_policy_fingerprint IS NULL OR octet_length(url_policy_fingerprint) = 32);

-- The altered relation remains server-only after this forward migration.
ALTER TABLE learning_sync_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE learning_sync_runs FROM PUBLIC;

DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE learning_sync_runs FROM %I', client_role);
    END IF;
  END LOOP;
END
$$;
