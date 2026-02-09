/**
 * Tests for section dependencies functionality - Task Selection
 *
 * Tests findNextTask with section dependencies
 */

import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../src/database/schema.js';
import {
  createSection,
  createTask,
  findNextTask,
} from '../src/database/queries.js';
import { v4 as uuidv4 } from 'uuid';

describe('Section Dependencies - Task Selection', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Create in-memory database
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);

    // Apply section_dependencies migration (priority and skipped are in SCHEMA_SQL)
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

  describe('Task Selection with Dependencies', () => {
    it('should skip tasks in sections with unmet dependencies', () => {
      const depSection = createSection(db, 'Dependency Section', 0);
      const mainSection = createSection(db, 'Main Section', 1);

      // Add dependency: mainSection depends on depSection
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add pending task to dependency section
      createTask(db, 'Dependency Task', {
        sectionId: depSection.id,
        status: 'pending',
      });

      // Add pending task to main section
      createTask(db, 'Main Task', {
        sectionId: mainSection.id,
        status: 'pending',
      });

      // Should select dependency task first, not main task
      const result = findNextTask(db);
      expect(result.task).not.toBeNull();
      expect(result.task?.title).toBe('Dependency Task');
      expect(result.action).toBe('start');
    });

    it('should select tasks from main section after dependencies are met', () => {
      const depSection = createSection(db, 'Dependency Section', 0);
      const mainSection = createSection(db, 'Main Section', 1);

      // Add dependency: mainSection depends on depSection
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add completed task to dependency section
      createTask(db, 'Dependency Task', {
        sectionId: depSection.id,
        status: 'completed',
      });

      // Add pending task to main section
      createTask(db, 'Main Task', {
        sectionId: mainSection.id,
        status: 'pending',
      });

      // Should select main task since dependency is complete
      const result = findNextTask(db);
      expect(result.task).not.toBeNull();
      expect(result.task?.title).toBe('Main Task');
      expect(result.action).toBe('start');
    });

    it('should allow tasks without sections regardless of dependencies', () => {
      const depSection = createSection(db, 'Dependency Section', 0);
      const mainSection = createSection(db, 'Main Section', 1);

      // Add dependency: mainSection depends on depSection
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add pending task to dependency section (blocks mainSection)
      createTask(db, 'Dependency Task', {
        sectionId: depSection.id,
        status: 'pending',
      });

      // Add pending task to main section (should be blocked)
      createTask(db, 'Main Task', {
        sectionId: mainSection.id,
        status: 'pending',
      });

      // Add task without section (should NOT be blocked)
      createTask(db, 'Unsectioned Task', {
        status: 'pending',
      });

      // Should select dependency task first
      const result1 = findNextTask(db);
      expect(result1.task?.title).toBe('Dependency Task');

      // Mark dependency as completed
      db.prepare('UPDATE tasks SET status = ? WHERE title = ?').run('completed', 'Dependency Task');

      // Now either Main Task or Unsectioned Task should be selectable
      const result2 = findNextTask(db);
      expect(result2.task).not.toBeNull();
      expect(['Main Task', 'Unsectioned Task']).toContain(result2.task?.title);
    });

    it('should respect priority order when multiple sections are blocked', () => {
      const dep1 = createSection(db, 'Dep 1', 0);
      const dep2 = createSection(db, 'Dep 2', 1);
      const section1 = createSection(db, 'Section 1', 2);
      const section2 = createSection(db, 'Section 2', 3);

      // section1 depends on dep1, section2 depends on dep2
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), section1.id, dep1.id);
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), section2.id, dep2.id);

      // Add pending tasks to dependencies
      createTask(db, 'Dep 1 Task', { sectionId: dep1.id, status: 'pending' });
      createTask(db, 'Dep 2 Task', { sectionId: dep2.id, status: 'pending' });

      // Add pending tasks to main sections
      createTask(db, 'Section 1 Task', { sectionId: section1.id, status: 'pending' });
      createTask(db, 'Section 2 Task', { sectionId: section2.id, status: 'pending' });

      // Should select from dep1 first (lower position)
      const result = findNextTask(db);
      expect(result.task?.title).toBe('Dep 1 Task');
    });

    it('should handle in_progress tasks in sections with unmet dependencies', () => {
      const depSection = createSection(db, 'Dependency Section', 0);
      const mainSection = createSection(db, 'Main Section', 1);

      // Add dependency: mainSection depends on depSection
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add pending task to dependency section
      createTask(db, 'Dependency Task', {
        sectionId: depSection.id,
        status: 'pending',
      });

      // Add in_progress task to main section
      createTask(db, 'Main Task In Progress', {
        sectionId: mainSection.id,
        status: 'in_progress',
      });

      // Should select dependency task, not the in_progress task in blocked section
      const result = findNextTask(db);
      expect(result.task?.title).toBe('Dependency Task');
    });

    it('should handle review tasks in sections with unmet dependencies', () => {
      const depSection = createSection(db, 'Dependency Section', 0);
      const mainSection = createSection(db, 'Main Section', 1);

      // Add dependency: mainSection depends on depSection
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add pending task to dependency section
      createTask(db, 'Dependency Task', {
        sectionId: depSection.id,
        status: 'pending',
      });

      // Add review task to main section
      createTask(db, 'Main Task Review', {
        sectionId: mainSection.id,
        status: 'review',
      });

      // Should select dependency task, not the review task in blocked section
      const result = findNextTask(db);
      expect(result.task?.title).toBe('Dependency Task');
    });
  });
});
