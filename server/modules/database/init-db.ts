import { getConnection } from "@/modules/database/connection.js";
import { runMigrations } from "@/modules/database/migrations.js";
import { INIT_SCHEMA_SQL } from "@/modules/database/schema.js";

/**
 * Initializes the database with the schema and runs pending migrations.
 *
 * `registeredProviderIds` is threaded down from the assembly root because one
 * migration step (seeding per-provider scan cursors) needs the full registered
 * provider set, and the database layer must not import the provider registry.
 * The argument is required, not defaulted: an omitted set silently under-seeds
 * and lets an upgrade revive archived rows, so a missing set is better caught
 * at compile time than at runtime.
 */
export const initializeDatabase = async (registeredProviderIds: string[]) => {
    try {
        const db = getConnection();
        db.exec(INIT_SCHEMA_SQL);
        console.log('Database schema applied');
        runMigrations(db, registeredProviderIds);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log('Database initialization failed', { error: message });
        throw err;
    }
};
