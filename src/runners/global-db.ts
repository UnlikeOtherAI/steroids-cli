/**
 * Global database for runner state
 * Located at ~/.steroids/steroids.db (user home, not project)
 *
 * This file re-exports all functionality from focused modules.
 * See individual modules for implementation details.
 */

// Schema and migrations
export {
  GLOBAL_SCHEMA_SQL,
  GLOBAL_SCHEMA_V2_SQL,
  GLOBAL_SCHEMA_V3_SQL,
  GLOBAL_SCHEMA_V4_SQL,
  GLOBAL_SCHEMA_V5_SQL,
  GLOBAL_SCHEMA_V6_SQL,
  GLOBAL_SCHEMA_V7_SQL,
  GLOBAL_SCHEMA_V8_SQL,
  GLOBAL_SCHEMA_V9_INDEX_AND_TRIGGERS_SQL,
  GLOBAL_SCHEMA_V10_SQL,
  GLOBAL_SCHEMA_V11_SQL,
  GLOBAL_SCHEMA_V12_SQL,
  GLOBAL_SCHEMA_V14_SQL,
  GLOBAL_SCHEMA_V15_SQL,
  GLOBAL_SCHEMA_V16_SQL,
  GLOBAL_SCHEMA_V17_SQL,
  GLOBAL_SCHEMA_V18_SQL,
  GLOBAL_SCHEMA_VERSION,
  applyGlobalSchemaV9,
  applyGlobalSchemaV10,
  applyGlobalSchemaV11,
  applyGlobalSchemaV12,
  applyGlobalSchemaV13,
  applyGlobalSchemaV14,
  applyGlobalSchemaV15,
  applyGlobalSchemaV16,
  applyGlobalSchemaV17,
  applyGlobalSchemaV18,
} from './global-db-schema';

// Connection management
export {
  type GlobalDatabaseConnection,
  getGlobalSteroidsDir,
  getGlobalDbPath,
  isGlobalDbInitialized,
  openGlobalDatabase,
  getGlobalSchemaVersion,
  withGlobalDatabase,
} from './global-db-connection';

// Daemon status
export {
  getDaemonActiveStatus,
  setDaemonActiveStatus,
} from './global-db-daemon';

// Parallel sessions
export {
  type ParallelSessionStatus,
  type ParallelSessionRunner,
  type PriorWorkstreamSeed,
  updateParallelSessionStatus,
  revokeWorkstreamLeasesForSession,
  listParallelSessionRunners,
  removeParallelSessionRunner,
  findPriorWorkstreamForSections,
} from './global-db-sessions';

// Validation escalations
export {
  type ValidationEscalationRecord,
  recordValidationEscalation,
  resolveValidationEscalationsForSession,
} from './global-db-validation';

// Provider backoffs
export {
  recordProviderBackoff,
  getProviderBackoffRemainingMs,
  clearProviderBackoff,
} from './global-db-backoffs';
