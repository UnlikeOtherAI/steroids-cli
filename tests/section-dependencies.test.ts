/**
 * Tests for section dependencies functionality
 */

import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../src/database/schema.js';
import {
  createSection,
  createTask,
  getPendingDependencies,
  hasDependenciesMet,
  type Section,
} from '../src/database/queries.js';
import { v4 as uuidv4 } from 'uuid';

describe('Section Dependencies', () => {
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

  describe('getPendingDependencies', () => {
    it('returns empty array when section has no dependencies', () => {
      const section = createSection(db, 'Test Section');
      const deps = getPendingDependencies(db, section.id);
      expect(deps).toEqual([]);
    });

    it('returns empty array when dependency has all tasks completed', () => {
      const depSection = createSection(db, 'Dependency Section');
      const mainSection = createSection(db, 'Main Section');

      // Add dependency
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add completed task to dependency
      createTask(db, 'Completed Task', {
        sectionId: depSection.id,
        status: 'completed',
      });

      const deps = getPendingDependencies(db, mainSection.id);
      expect(deps).toEqual([]);
    });

    it('returns dependency when it has pending tasks', () => {
      const depSection = createSection(db, 'Dependency Section');
      const mainSection = createSection(db, 'Main Section');

      // Add dependency
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add pending task to dependency
      createTask(db, 'Pending Task', {
        sectionId: depSection.id,
        status: 'pending',
      });

      const deps = getPendingDependencies(db, mainSection.id);
      expect(deps.length).toBe(1);
      expect(deps[0].id).toBe(depSection.id);
    });

    it('returns dependency when it has in_progress tasks', () => {
      const depSection = createSection(db, 'Dependency Section');
      const mainSection = createSection(db, 'Main Section');

      // Add dependency
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add in_progress task to dependency
      createTask(db, 'In Progress Task', {
        sectionId: depSection.id,
        status: 'in_progress',
      });

      const deps = getPendingDependencies(db, mainSection.id);
      expect(deps.length).toBe(1);
      expect(deps[0].id).toBe(depSection.id);
    });

    it('returns dependency when it has review tasks', () => {
      const depSection = createSection(db, 'Dependency Section');
      const mainSection = createSection(db, 'Main Section');

      // Add dependency
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add review task to dependency
      createTask(db, 'Review Task', {
        sectionId: depSection.id,
        status: 'review',
      });

      const deps = getPendingDependencies(db, mainSection.id);
      expect(deps.length).toBe(1);
      expect(deps[0].id).toBe(depSection.id);
    });

    it('returns multiple dependencies when multiple have pending tasks', () => {
      const dep1 = createSection(db, 'Dependency 1');
      const dep2 = createSection(db, 'Dependency 2');
      const mainSection = createSection(db, 'Main Section');

      // Add dependencies
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, dep1.id);
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, dep2.id);

      // Add pending tasks to both dependencies
      createTask(db, 'Task 1', { sectionId: dep1.id, status: 'pending' });
      createTask(db, 'Task 2', { sectionId: dep2.id, status: 'pending' });

      const deps = getPendingDependencies(db, mainSection.id);
      expect(deps.length).toBe(2);
    });

    it('excludes dependencies with only completed tasks', () => {
      const dep1 = createSection(db, 'Dependency 1');
      const dep2 = createSection(db, 'Dependency 2');
      const mainSection = createSection(db, 'Main Section');

      // Add dependencies
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, dep1.id);
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, dep2.id);

      // dep1 has pending task, dep2 has completed task
      createTask(db, 'Task 1', { sectionId: dep1.id, status: 'pending' });
      createTask(db, 'Task 2', { sectionId: dep2.id, status: 'completed' });

      const deps = getPendingDependencies(db, mainSection.id);
      expect(deps.length).toBe(1);
      expect(deps[0].id).toBe(dep1.id);
    });
  });

  describe('hasDependenciesMet', () => {
    it('returns true when section has no dependencies', () => {
      const section = createSection(db, 'Test Section');
      expect(hasDependenciesMet(db, section.id)).toBe(true);
    });

    it('returns true when all dependency tasks are completed', () => {
      const depSection = createSection(db, 'Dependency Section');
      const mainSection = createSection(db, 'Main Section');

      // Add dependency
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add completed task to dependency
      createTask(db, 'Completed Task', {
        sectionId: depSection.id,
        status: 'completed',
      });

      expect(hasDependenciesMet(db, mainSection.id)).toBe(true);
    });

    it('returns false when dependency has pending tasks', () => {
      const depSection = createSection(db, 'Dependency Section');
      const mainSection = createSection(db, 'Main Section');

      // Add dependency
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add pending task to dependency
      createTask(db, 'Pending Task', {
        sectionId: depSection.id,
        status: 'pending',
      });

      expect(hasDependenciesMet(db, mainSection.id)).toBe(false);
    });

    it('returns false when dependency has in_progress tasks', () => {
      const depSection = createSection(db, 'Dependency Section');
      const mainSection = createSection(db, 'Main Section');

      // Add dependency
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add in_progress task to dependency
      createTask(db, 'In Progress Task', {
        sectionId: depSection.id,
        status: 'in_progress',
      });

      expect(hasDependenciesMet(db, mainSection.id)).toBe(false);
    });

    it('returns false when any dependency has incomplete tasks', () => {
      const dep1 = createSection(db, 'Dependency 1');
      const dep2 = createSection(db, 'Dependency 2');
      const mainSection = createSection(db, 'Main Section');

      // Add dependencies
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, dep1.id);
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, dep2.id);

      // dep1 has completed task, dep2 has pending task
      createTask(db, 'Task 1', { sectionId: dep1.id, status: 'completed' });
      createTask(db, 'Task 2', { sectionId: dep2.id, status: 'pending' });

      expect(hasDependenciesMet(db, mainSection.id)).toBe(false);
    });

    it('returns true when all dependencies have completed tasks', () => {
      const dep1 = createSection(db, 'Dependency 1');
      const dep2 = createSection(db, 'Dependency 2');
      const mainSection = createSection(db, 'Main Section');

      // Add dependencies
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, dep1.id);
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, dep2.id);

      // Both have completed tasks
      createTask(db, 'Task 1', { sectionId: dep1.id, status: 'completed' });
      createTask(db, 'Task 2', { sectionId: dep2.id, status: 'completed' });

      expect(hasDependenciesMet(db, mainSection.id)).toBe(true);
    });
  });
});
