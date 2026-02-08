/**
 * Global project registry management
 * Tracks all registered steroids projects across the system
 */
export interface RegisteredProject {
    path: string;
    name: string | null;
    registered_at: string;
    last_seen_at: string;
    enabled: boolean;
}
/**
 * Register a project in the global registry
 * Idempotent - updates last_seen_at if project already exists
 *
 * @param path - Absolute path to project directory
 * @param name - Optional project name
 */
export declare function registerProject(path: string, name?: string): void;
/**
 * Get all registered projects (enabled only by default)
 *
 * @param includeDisabled - If true, includes disabled projects
 * @returns Array of registered projects
 */
export declare function getRegisteredProjects(includeDisabled?: boolean): RegisteredProject[];
/**
 * Get a single registered project by path
 *
 * @param path - Project path to look up
 * @returns Project if found, null otherwise
 */
export declare function getRegisteredProject(path: string): RegisteredProject | null;
/**
 * Unregister a project from the global registry
 * Removes it completely from the database
 *
 * @param path - Project path to unregister
 */
export declare function unregisterProject(path: string): void;
/**
 * Disable a project (skip in wakeup, but keep in registry)
 *
 * @param path - Project path to disable
 */
export declare function disableProject(path: string): void;
/**
 * Enable a project (include in wakeup)
 *
 * @param path - Project path to enable
 */
export declare function enableProject(path: string): void;
/**
 * Remove projects that no longer exist on disk
 * Returns the number of projects removed
 *
 * @returns Number of projects pruned
 */
export declare function pruneProjects(): number;
/**
 * Update last_seen_at timestamp for a project
 * Used by runners to track when project was last active
 *
 * @param path - Project path to update
 */
export declare function updateProjectLastSeen(path: string): void;
/**
 * Check if a project is registered
 *
 * @param path - Project path to check
 * @returns True if project is registered
 */
export declare function isProjectRegistered(path: string): boolean;
//# sourceMappingURL=projects.d.ts.map