import { getConnection } from '@/modules/database/connection.js';

type ScanStateRow = {
  last_scanned_at: string;
};

export const scanStateDb = {
    getLastScannedAt(provider: string) {
        const db = getConnection();

        const row = db
            .prepare(`SELECT last_scanned_at FROM provider_scan_state WHERE provider = ?`)
            .get(provider) as ScanStateRow;

        if (!row) {
            return null; // Before the provider's first scan, the row is undefined.
        }

        let lastScannedDate: Date | null = null;
        const lastScannedStr = row.last_scanned_at;

        if (lastScannedStr) {
            // SQLite CURRENT_TIMESTAMP returns UTC in "YYYY-MM-DD HH:MM:SS" format.
            // Replace space with 'T' and append 'Z' to parse reliably in JS across all platforms.
            lastScannedDate = new Date(lastScannedStr.replace(' ', 'T') + 'Z');
        }

        return lastScannedDate;
    },

    updateLastScannedAt(provider: string, scannedAt: Date = new Date()) {
        const db = getConnection();
        const sqliteTimestamp = scannedAt.toISOString().slice(0, 19).replace('T', ' ');

        db.prepare(`
            INSERT INTO provider_scan_state (provider, last_scanned_at)
            VALUES (?, ?)
            ON CONFLICT (provider)
            DO UPDATE SET last_scanned_at = excluded.last_scanned_at
        `).run(provider, sqliteTimestamp);
    }
};
