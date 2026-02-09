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
  findNextTask,
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

    it('returns dependency when it has disputed tasks', () => {
      const depSection = createSection(db, 'Dependency Section');
      const mainSection = createSection(db, 'Main Section');

      // Add dependency
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add disputed task to dependency
      createTask(db, 'Disputed Task', {
        sectionId: depSection.id,
        status: 'disputed',
      });

      const deps = getPendingDependencies(db, mainSection.id);
      expect(deps.length).toBe(1);
      expect(deps[0].id).toBe(depSection.id);
    });

    it('returns dependency when it has failed tasks', () => {
      const depSection = createSection(db, 'Dependency Section');
      const mainSection = createSection(db, 'Main Section');

      // Add dependency
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add failed task to dependency
      createTask(db, 'Failed Task', {
        sectionId: depSection.id,
        status: 'failed',
      });

      const deps = getPendingDependencies(db, mainSection.id);
      expect(deps.length).toBe(1);
      expect(deps[0].id).toBe(depSection.id);
    });

    it('returns dependency when it has skipped tasks', () => {
      const depSection = createSection(db, 'Dependency Section');
      const mainSection = createSection(db, 'Main Section');

      // Add dependency
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add skipped task to dependency
      createTask(db, 'Skipped Task', {
        sectionId: depSection.id,
        status: 'skipped',
      });

      const deps = getPendingDependencies(db, mainSection.id);
      expect(deps.length).toBe(1);
      expect(deps[0].id).toBe(depSection.id);
    });

    it('returns dependency when it has partial tasks', () => {
      const depSection = createSection(db, 'Dependency Section');
      const mainSection = createSection(db, 'Main Section');

      // Add dependency
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add partial task to dependency
      createTask(db, 'Partial Task', {
        sectionId: depSection.id,
        status: 'partial',
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

    it('returns false when dependency has disputed tasks', () => {
      const depSection = createSection(db, 'Dependency Section');
      const mainSection = createSection(db, 'Main Section');

      // Add dependency
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add disputed task to dependency
      createTask(db, 'Disputed Task', {
        sectionId: depSection.id,
        status: 'disputed',
      });

      expect(hasDependenciesMet(db, mainSection.id)).toBe(false);
    });

    it('returns false when dependency has failed tasks', () => {
      const depSection = createSection(db, 'Dependency Section');
      const mainSection = createSection(db, 'Main Section');

      // Add dependency
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add failed task to dependency
      createTask(db, 'Failed Task', {
        sectionId: depSection.id,
        status: 'failed',
      });

      expect(hasDependenciesMet(db, mainSection.id)).toBe(false);
    });

    it('returns false when dependency has skipped tasks', () => {
      const depSection = createSection(db, 'Dependency Section');
      const mainSection = createSection(db, 'Main Section');

      // Add dependency
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add skipped task to dependency
      createTask(db, 'Skipped Task', {
        sectionId: depSection.id,
        status: 'skipped',
      });

      expect(hasDependenciesMet(db, mainSection.id)).toBe(false);
    });

    it('returns false when dependency has partial tasks', () => {
      const depSection = createSection(db, 'Dependency Section');
      const mainSection = createSection(db, 'Main Section');

      // Add dependency
      db.prepare(
        'INSERT INTO section_dependencies (id, section_id, depends_on_section_id) VALUES (?, ?, ?)'
      ).run(uuidv4(), mainSection.id, depSection.id);

      // Add partial task to dependency
      createTask(db, 'Partial Task', {
        sectionId: depSection.id,
        status: 'partial',
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
