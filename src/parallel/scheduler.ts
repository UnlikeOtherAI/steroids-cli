/**
 * Workstream scheduler for parallel section execution.
 *
 * Responsibilities:
 * - Validate dependency graphs (including cycle detection)
 * - Create deterministic topological ordering
 * - Partition sections into connected components (undirected)
 * - Order each workstream by topological sort
 */

export interface WorkstreamSection {
  id: string;
  name?: string;
  position?: number;
}

export interface SectionDependency {
  sectionId: string;
  dependsOnSectionId: string;
}

export interface WorkstreamPartition {
  workstreams: string[][];
}

export class CyclicDependencyError extends Error {
  public readonly cycle: string[];

  constructor(cycle: string[]) {
    super(`Cyclic dependency detected: ${cycle.join(' -> ')}`);
    this.name = 'CyclicDependencyError';
    this.cycle = cycle;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CyclicDependencyError);
    }
  }
}

export interface GraphData {
  sectionsById: Map<string, WorkstreamSection>;
  orderMap: Map<string, number>;
  dependencyMap: Map<string, Set<string>>; // section -> direct dependencies
  reverseDependencyMap: Map<string, Set<string>>; // section -> dependent sections
  undirectedDependencyMap: Map<string, Set<string>>;
}

function buildSectionOrderMap(sections: WorkstreamSection[]): Map<string, number> {
  const orderMap = new Map<string, number>();

  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i];
    if (orderMap.has(section.id)) {
      throw new Error(`Duplicate section id: ${section.id}`);
    }

    const explicitPosition = section.position;
    orderMap.set(section.id, explicitPosition ?? i);
  }

  return orderMap;
}

function compareSectionIds(
  a: string,
  b: string,
  orderMap: Map<string, number>
): number {
  const posA = orderMap.get(a) ?? Number.MAX_SAFE_INTEGER;
  const posB = orderMap.get(b) ?? Number.MAX_SAFE_INTEGER;

  if (posA !== posB) {
    return posA - posB;
  }

  return a.localeCompare(b);
}

function buildGraphData(
  sections: WorkstreamSection[],
  dependencies: SectionDependency[]
): GraphData {
  const sectionsById = new Map<string, WorkstreamSection>();
  const orderMap = buildSectionOrderMap(sections);
  const dependencyMap = new Map<string, Set<string>>();
  const reverseDependencyMap = new Map<string, Set<string>>();
  const undirectedDependencyMap = new Map<string, Set<string>>();

  for (const section of sections) {
    sectionsById.set(section.id, section);
    dependencyMap.set(section.id, new Set());
    reverseDependencyMap.set(section.id, new Set());
    undirectedDependencyMap.set(section.id, new Set());
  }

  for (const dependency of dependencies) {
    const { sectionId, dependsOnSectionId } = dependency;

    if (!sectionsById.has(sectionId)) {
      throw new Error(`Unknown section in dependency: ${sectionId}`);
    }

    if (!sectionsById.has(dependsOnSectionId)) {
      throw new Error(`Unknown section in dependency: ${dependsOnSectionId}`);
    }

    const deps = dependencyMap.get(sectionId);
    const dependents = reverseDependencyMap.get(dependsOnSectionId);
    const leftAdj = undirectedDependencyMap.get(sectionId);
    const rightAdj = undirectedDependencyMap.get(dependsOnSectionId);

    if (!deps || !dependents || !leftAdj || !rightAdj) {
      throw new Error('Dependency graph is not initialized correctly');
    }

    if (!deps.has(dependsOnSectionId)) {
      deps.add(dependsOnSectionId);
      dependents.add(sectionId);
      leftAdj.add(dependsOnSectionId);
      rightAdj.add(sectionId);
    }
  }

  for (const adjacency of [dependencyMap, reverseDependencyMap, undirectedDependencyMap]) {
    for (const [sectionId, neighbors] of adjacency.entries()) {
      const orderedNeighbors = [...neighbors].sort((a, b) => compareSectionIds(a, b, orderMap));
      adjacency.set(sectionId, new Set(orderedNeighbors));
    }
  }

  return {
    sectionsById,
    orderMap,
    dependencyMap,
    reverseDependencyMap,
    undirectedDependencyMap,
  };
}

function detectCycleInGraph(
  sections: WorkstreamSection[],
  dependencies: SectionDependency[],
  sectionFilter?: Set<string>
): string[] | null {
  const graph = buildGraphData(sections, dependencies);
  const allSectionIds = [...graph.sectionsById.keys()]
    .filter((id) => !sectionFilter || sectionFilter.has(id))
    .sort((a, b) => compareSectionIds(a, b, graph.orderMap));

  if (allSectionIds.length === 0) {
    return null;
  }

  const state = new Map<string, 'unvisited' | 'visiting' | 'done'>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();

  for (const sectionId of allSectionIds) {
    state.set(sectionId, 'unvisited');
  }

  const visitedNeighbors = (currentId: string): string[] => {
    const neighbors = graph.dependencyMap.get(currentId);
    if (!neighbors) {
      return [];
    }

    return [...neighbors]
      .filter((neighborId) => !sectionFilter || sectionFilter.has(neighborId))
      .sort((a, b) => compareSectionIds(a, b, graph.orderMap));
  };

  const dfs = (currentId: string): string[] | null => {
    state.set(currentId, 'visiting');
    stackIndex.set(currentId, stack.length);
    stack.push(currentId);

    for (const neighborId of visitedNeighbors(currentId)) {
      const neighborState = state.get(neighborId);

      if (neighborState === 'visiting') {
        const start = stackIndex.get(neighborId);
        if (start === undefined) {
          continue;
        }

        return [...stack.slice(start), neighborId];
      }

      if (neighborState === 'unvisited') {
        const cycle = dfs(neighborId);
        if (cycle) {
          return cycle;
        }
      }
    }

    stack.pop();
    stackIndex.delete(currentId);
    state.set(currentId, 'done');

    return null;
  };

  for (const sectionId of allSectionIds) {
    if (state.get(sectionId) === 'unvisited') {
      const cycle = dfs(sectionId);
      if (cycle) {
        return cycle;
      }
    }
  }

  return null;
}

export function topologicalSortSections(
  sections: WorkstreamSection[],
  dependencies: SectionDependency[],
  sectionFilter?: string[]
): string[] {
  const graph = buildGraphData(sections, dependencies);
  const validSectionIds = new Set(
    sectionFilter ? [...sectionFilter] : [...graph.sectionsById.keys()]
  );

  for (const sectionId of validSectionIds) {
    if (!graph.sectionsById.has(sectionId)) {
      throw new Error(`Unknown section in filter: ${sectionId}`);
    }
  }

  const relevantSectionIds = [...validSectionIds].sort((a, b) => compareSectionIds(a, b, graph.orderMap));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, Set<string>>();

  for (const sectionId of relevantSectionIds) {
    indegree.set(sectionId, 0);
    dependents.set(sectionId, new Set());
  }

  for (const [sectionId, directDeps] of graph.dependencyMap.entries()) {
    if (!relevantSectionIds.includes(sectionId)) {
      continue;
    }

    for (const dependsOnSectionId of directDeps) {
      if (!relevantSectionIds.includes(dependsOnSectionId)) {
        continue;
      }

      const currentDependents = dependents.get(dependsOnSectionId);
      if (!currentDependents) {
        throw new Error('Dependency graph is inconsistent');
      }

      if (!currentDependents.has(sectionId)) {
        currentDependents.add(sectionId);
        indegree.set(sectionId, (indegree.get(sectionId) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const sectionId of relevantSectionIds) {
    if ((indegree.get(sectionId) ?? 0) === 0) {
      queue.push(sectionId);
    }
  }

  const order: string[] = [];

  while (queue.length > 0) {
    queue.sort((a, b) => compareSectionIds(a, b, graph.orderMap));
    const current = queue.shift() as string;
    order.push(current);

    const outgoing = dependents.get(current) ?? new Set();
    for (const dependentId of outgoing) {
      const next = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, next);

      if (next === 0) {
        queue.push(dependentId);
      }
    }
  }

  if (order.length !== relevantSectionIds.length) {
    const cycle = detectCycleInGraph(sections, dependencies, validSectionIds);
    if (cycle) {
      throw new CyclicDependencyError(cycle);
    }

    throw new Error('Unable to complete topological sort because dependencies are inconsistent');
  }

  return order;
}

function getConnectedComponents(
  graph: GraphData,
  sectionIds: string[]
): string[][] {
  const sectionSet = new Set(sectionIds);
  const visited = new Set<string>();
  const components: string[][] = [];

  const sortedStartingNodes = [...sectionIds].sort((a, b) =>
    compareSectionIds(a, b, graph.orderMap)
  );

  for (const sectionId of sortedStartingNodes) {
    if (visited.has(sectionId)) {
      continue;
    }

    const queue = [sectionId];
    const component: string[] = [];

    visited.add(sectionId);

    while (queue.length > 0) {
      const current = queue.shift() as string;
      component.push(current);

      const neighbors = graph.undirectedDependencyMap.get(current);
      if (!neighbors) {
        continue;
      }

      const sortedNeighbors = [...neighbors]
        .filter((neighborId) => sectionSet.has(neighborId) && !visited.has(neighborId))
        .sort((a, b) => compareSectionIds(a, b, graph.orderMap));

      for (const neighborId of sortedNeighbors) {
        visited.add(neighborId);
        queue.push(neighborId);
      }
    }

    components.push(component);
  }

  return components;
}

export function partitionWorkstreams(
  sections: WorkstreamSection[],
  dependencies: SectionDependency[]
): WorkstreamPartition {
  const sortedAll = topologicalSortSections(sections, dependencies);
  const graph = buildGraphData(sections, dependencies);
  const components = getConnectedComponents(graph, sortedAll);

  const position = new Map<string, number>();
  sortedAll.forEach((sectionId, index) => position.set(sectionId, index));

  const orderedComponents = components
    .slice()
    .map((component) => ({
      component,
      minOrder: Math.min(...component.map((sectionId) => position.get(sectionId) ?? Number.MAX_SAFE_INTEGER)),
    }))
    .sort((a, b) => {
      if (a.minOrder !== b.minOrder) {
        return a.minOrder - b.minOrder;
      }

      const aId = a.component[0] ?? '';
      const bId = b.component[0] ?? '';
      return compareSectionIds(aId, bId, graph.orderMap);
    });

  const workstreams = orderedComponents.map(({ component }) =>
    topologicalSortSections(sections, dependencies, component)
  );

  return { workstreams };
}

export const createWorkstreams = partitionWorkstreams;
export const scheduleWorkstreams = partitionWorkstreams;
export const partitionIntoWorkstreams = partitionWorkstreams;
export const partitionSectionsIntoWorkstreams = partitionWorkstreams;
export const buildWorkstreams = partitionWorkstreams;
export const topologicalSort = topologicalSortSections;
export const topologicalSortSectionIds = topologicalSortSections;
export const findConnectedComponents = (
  sections: WorkstreamSection[],
  dependencies: SectionDependency[]
): string[][] => {
  const graph = buildGraphData(sections, dependencies);
  return getConnectedComponents(graph, [...graph.sectionsById.keys()].sort((a, b) => compareSectionIds(a, b, graph.orderMap)));
};
