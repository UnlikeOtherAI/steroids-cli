/**
 * Tests for workstream scheduler topological sorting and partitioning.
 */

import {
  CyclicDependencyError,
  partitionWorkstreams,
  topologicalSortSections,
  type SectionDependency,
  type WorkstreamSection,
} from '../src/parallel/scheduler.js';

describe('Workstream scheduler', () => {
  const sections: WorkstreamSection[] = [
    { id: 'A' },
    { id: 'B' },
    { id: 'C' },
    { id: 'D' },
    { id: 'E' },
  ];

  describe('topologicalSortSections', () => {
    it('sorts a simple linear dependency chain (A -> B -> C)', () => {
      const dependencies: SectionDependency[] = [
        { sectionId: 'B', dependsOnSectionId: 'A' },
        { sectionId: 'C', dependsOnSectionId: 'B' },
      ];
      const result = topologicalSortSections(sections, dependencies);
      expect(result).toEqual(['A', 'B', 'C', 'D', 'E']);
    });

    it('supports multiple parallel sections with no dependencies', () => {
      const result = topologicalSortSections(sections.slice(0, 3), []);
      expect(result).toEqual(['A', 'B', 'C']);
    });

    it('throws CyclicDependencyError with the detected cycle path', () => {
      const dependencies: SectionDependency[] = [
        { sectionId: 'A', dependsOnSectionId: 'B' },
        { sectionId: 'B', dependsOnSectionId: 'A' },
      ];

      expect.assertions(4);

      try {
        topologicalSortSections(sections, dependencies);
      } catch (error) {
        expect(error).toBeInstanceOf(CyclicDependencyError);
        expect(error).toHaveProperty('cycle', ['A', 'B', 'A']);
        expect((error as Error).name).toBe('CyclicDependencyError');
        expect((error as Error).message).toBe(
          'Cyclic dependency detected: A -> B -> A'
        );
      }
    });

    it('filters sections when sectionFilter is provided', () => {
      const dependencies: SectionDependency[] = [
        { sectionId: 'B', dependsOnSectionId: 'A' },
        { sectionId: 'C', dependsOnSectionId: 'B' },
      ];
      const result = topologicalSortSections(sections, dependencies, ['B', 'C']);
      expect(result).toEqual(['B', 'C']);
    });
  });

  describe('partitionWorkstreams', () => {
    it('partitions multiple connected components into independent workstreams', () => {
      const dependencies: SectionDependency[] = [
        { sectionId: 'B', dependsOnSectionId: 'A' },
        { sectionId: 'D', dependsOnSectionId: 'C' },
      ];
      const result = partitionWorkstreams(sections, dependencies);
      expect(result).toEqual({
        workstreams: [
          ['A', 'B'],
          ['C', 'D'],
          ['E'],
        ],
      });
    });

    it('handles mixed dependency and independent sections', () => {
      const dependencies: SectionDependency[] = [
        { sectionId: 'C', dependsOnSectionId: 'A' },
        { sectionId: 'D', dependsOnSectionId: 'C' },
      ];
      const result = partitionWorkstreams(sections, dependencies);
      expect(result).toEqual({
        workstreams: [
          ['A', 'C', 'D'],
          ['B'],
          ['E'],
        ],
      });
    });

    it('returns one workstream for a single section', () => {
      const result = partitionWorkstreams([{ id: 'A' }], []);
      expect(result).toEqual({ workstreams: [['A']] });
    });
  });

  it('returns empty workstreams for empty sections input', () => {
    expect(topologicalSortSections([], [])).toEqual([]);
    expect(partitionWorkstreams([], [])).toEqual({ workstreams: [] });
  });

  it('throws on duplicate section IDs', () => {
    const duplicateSections: WorkstreamSection[] = [
      { id: 'A' },
      { id: 'A' },
    ];
    expect(() => topologicalSortSections(duplicateSections, [])).toThrow(
      'Duplicate section id: A'
    );
  });

  it('throws for unknown sections used in dependencies', () => {
    const dependencies: SectionDependency[] = [
      { sectionId: 'A', dependsOnSectionId: 'Z' },
    ];

    expect(() => topologicalSortSections([{ id: 'A' }], dependencies)).toThrow(
      'Unknown section in dependency: Z'
    );
  });

  it('sorts deterministically for identical section position inputs', () => {
    const positionedSections: WorkstreamSection[] = [
      { id: 'b', position: 10 },
      { id: 'a', position: 10 },
      { id: 'c', position: 20 },
    ];

    const first = topologicalSortSections(positionedSections, []);
    const second = topologicalSortSections(positionedSections, []);
    expect(first).toEqual(['a', 'b', 'c']);
    expect(second).toEqual(first);
  });
});
