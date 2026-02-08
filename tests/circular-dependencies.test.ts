/**
 * Tests for circular dependency detection
 */

import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../src/database/schema.js';
import {
  createSection,
  addSectionDependency,
  wouldCreateCircularDependency,
  type Section,
} from '../src/database/queries.js';

describe('Circular Dependency Detection', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Create in-memory database
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);

    // Apply migrations for priority and dependencies
    db.exec('ALTER TABLE sections ADD COLUMN priority INTEGER DEFAULT 50');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sections_priority ON sections(priority)');

    db.exec(`
      CREATE TABLE IF NOT EXISTS section_dependencies (
        id TEXT PRIMARY KEY,
        section_id TEXT NOT NULL REFERENCES sections(id),
        depends_on_section_id TEXT NOT NULL REFERENCES sections(id),
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(section_id, depends_on_section_id)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_section_dependencies_section ON section_dependencies(section_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_section_dependencies_depends_on ON section_dependencies(depends_on_section_id)');
  });

  afterEach(() => {
    db.close();
  });

  describe('wouldCreateCircularDependency', () => {
    it('detects self-dependency', () => {
      const section = createSection(db, 'Section A');
      const result = wouldCreateCircularDependency(db, section.id, section.id);
      expect(result).toBe(true);
    });

    it('allows simple dependency (no cycle)', () => {
      const sectionA = createSection(db, 'Section A');
      const sectionB = createSection(db, 'Section B');

      const result = wouldCreateCircularDependency(db, sectionA.id, sectionB.id);
      expect(result).toBe(false);
    });

    it('detects direct circular dependency (A -> B -> A)', () => {
      const sectionA = createSection(db, 'Section A');
      const sectionB = createSection(db, 'Section B');

      // A depends on B
      addSectionDependency(db, sectionA.id, sectionB.id);

      // Try to make B depend on A (would create cycle)
      const result = wouldCreateCircularDependency(db, sectionB.id, sectionA.id);
      expect(result).toBe(true);
    });

    it('detects indirect circular dependency (A -> B -> C -> A)', () => {
      const sectionA = createSection(db, 'Section A');
      const sectionB = createSection(db, 'Section B');
      const sectionC = createSection(db, 'Section C');

      // A depends on B
      addSectionDependency(db, sectionA.id, sectionB.id);

      // B depends on C
      addSectionDependency(db, sectionB.id, sectionC.id);

      // Try to make C depend on A (would create cycle)
      const result = wouldCreateCircularDependency(db, sectionC.id, sectionA.id);
      expect(result).toBe(true);
    });

    it('detects longer circular dependency chain (A -> B -> C -> D -> A)', () => {
      const sectionA = createSection(db, 'Section A');
      const sectionB = createSection(db, 'Section B');
      const sectionC = createSection(db, 'Section C');
      const sectionD = createSection(db, 'Section D');

      // Create chain: A -> B -> C -> D
      addSectionDependency(db, sectionA.id, sectionB.id);
      addSectionDependency(db, sectionB.id, sectionC.id);
      addSectionDependency(db, sectionC.id, sectionD.id);

      // Try to make D depend on A (would create cycle)
      const result = wouldCreateCircularDependency(db, sectionD.id, sectionA.id);
      expect(result).toBe(true);
    });

    it('allows branching dependencies (diamond shape)', () => {
      const sectionA = createSection(db, 'Section A');
      const sectionB = createSection(db, 'Section B');
      const sectionC = createSection(db, 'Section C');
      const sectionD = createSection(db, 'Section D');

      // Create diamond: D depends on both B and C, both B and C depend on A
      addSectionDependency(db, sectionB.id, sectionA.id);
      addSectionDependency(db, sectionC.id, sectionA.id);
      addSectionDependency(db, sectionD.id, sectionB.id);

      // This should be allowed (no cycle)
      const result = wouldCreateCircularDependency(db, sectionD.id, sectionC.id);
      expect(result).toBe(false);
    });

    it('detects cycle in complex graph with multiple paths', () => {
      const sectionA = createSection(db, 'Section A');
      const sectionB = createSection(db, 'Section B');
      const sectionC = createSection(db, 'Section C');
      const sectionD = createSection(db, 'Section D');
      const sectionE = createSection(db, 'Section E');

      // Create complex graph:
      // A -> B
      // A -> C
      // B -> D
      // C -> D
      // D -> E
      addSectionDependency(db, sectionA.id, sectionB.id);
      addSectionDependency(db, sectionA.id, sectionC.id);
      addSectionDependency(db, sectionB.id, sectionD.id);
      addSectionDependency(db, sectionC.id, sectionD.id);
      addSectionDependency(db, sectionD.id, sectionE.id);

      // Try to make E depend on A (would create cycle through multiple paths)
      const result = wouldCreateCircularDependency(db, sectionE.id, sectionA.id);
      expect(result).toBe(true);
    });
  });

  describe('addSectionDependency with validation', () => {
    it('prevents self-dependency', () => {
      const section = createSection(db, 'Section A');

      expect(() => {
        addSectionDependency(db, section.id, section.id);
      }).toThrow('Cannot add dependency: would create a circular dependency');
    });

    it('prevents direct circular dependency', () => {
      const sectionA = createSection(db, 'Section A');
      const sectionB = createSection(db, 'Section B');

      // A depends on B
      addSectionDependency(db, sectionA.id, sectionB.id);

      // B cannot depend on A
      expect(() => {
        addSectionDependency(db, sectionB.id, sectionA.id);
      }).toThrow('Cannot add dependency: would create a circular dependency');
    });

    it('prevents indirect circular dependency', () => {
      const sectionA = createSection(db, 'Section A');
      const sectionB = createSection(db, 'Section B');
      const sectionC = createSection(db, 'Section C');

      // A -> B -> C
      addSectionDependency(db, sectionA.id, sectionB.id);
      addSectionDependency(db, sectionB.id, sectionC.id);

      // C cannot depend on A
      expect(() => {
        addSectionDependency(db, sectionC.id, sectionA.id);
      }).toThrow('Cannot add dependency: would create a circular dependency');
    });

    it('allows valid dependencies in chain', () => {
      const sectionA = createSection(db, 'Section A');
      const sectionB = createSection(db, 'Section B');
      const sectionC = createSection(db, 'Section C');
      const sectionD = createSection(db, 'Section D');

      // Create valid chain: A -> B -> C -> D
      expect(() => {
        addSectionDependency(db, sectionA.id, sectionB.id);
        addSectionDependency(db, sectionB.id, sectionC.id);
        addSectionDependency(db, sectionC.id, sectionD.id);
      }).not.toThrow();
    });

    it('allows branching dependencies', () => {
      const sectionA = createSection(db, 'Section A');
      const sectionB = createSection(db, 'Section B');
      const sectionC = createSection(db, 'Section C');
      const sectionD = createSection(db, 'Section D');

      // Create diamond: D depends on both B and C, both B and C depend on A
      expect(() => {
        addSectionDependency(db, sectionB.id, sectionA.id);
        addSectionDependency(db, sectionC.id, sectionA.id);
        addSectionDependency(db, sectionD.id, sectionB.id);
        addSectionDependency(db, sectionD.id, sectionC.id);
      }).not.toThrow();
    });
  });
});
