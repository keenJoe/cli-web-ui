-- Manual rollback for the provider-native session id unique index.
--
-- The migration runner in server/modules/database/migrations.ts is
-- forward-only: it has no version table and no down migrations. Rolling the
-- application code back to a release that predates
-- `refactor-provider-seams` therefore leaves
-- `idx_sessions_provider_native_id` in place. The old merge logic still works
-- with the index present (it deletes before it updates), but this script is
-- the supported way to remove it if a rollback needs the pre-migration schema
-- exactly.
--
-- Usage:
--   sqlite3 ~/.cloudcli/auth.db < scripts/rollback/drop-provider-native-id-index.sql
--
-- Stop the server first: the index is dropped in a single transaction, but a
-- running server may re-create it on its next start via runMigrations().
--
-- This script only drops an index. It does not restore `provider_session_id`
-- values that the migration cleared while reconciling duplicates; those are
-- re-assigned by the session synchronizer on its next scan.

BEGIN TRANSACTION;

DROP INDEX IF EXISTS idx_sessions_provider_native_id;

COMMIT;
