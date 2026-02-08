/**
 * Global database for runner state
 * Located at ~/.steroids/steroids.db (user home, not project)
 */
import Database from 'better-sqlite3';
export interface GlobalDatabaseConnection {
    db: Database.Database;
    close: () => void;
}
/**
 * Get the path to the global steroids directory
 */
export declare function getGlobalSteroidsDir(): string;
/**
 * Get the path to the global database
 */
export declare function getGlobalDbPath(): string;
/**
 * Check if global database exists
 */
export declare function isGlobalDbInitialized(): boolean;
/**
 * Initialize and open the global database
 * Creates it if it doesn't exist
 */
export declare function openGlobalDatabase(): GlobalDatabaseConnection;
/**
 * Get global schema version
 */
export declare function getGlobalSchemaVersion(db: Database.Database): string | null;
//# sourceMappingURL=global-db.d.ts.map