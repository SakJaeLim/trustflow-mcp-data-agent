import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GraphHop, GraphStep } from "../core/model.ts";

export interface GraphNode {
  id: string;
  type: string;
  name: string;
  properties: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  properties?: Record<string, unknown>;
}

export interface GraphPath {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphTraversalResult {
  mode: "traverse" | "rank";
  start?: GraphNode;
  starts: GraphNode[];
  paths: GraphPath[];
  resultNodes: GraphNode[];
  ranking?: Array<{ node: GraphNode; count: number }>;
}

interface FrontierItem {
  node: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export class GraphStore {
  private readonly nodes: GraphNode[];
  private readonly edges: GraphEdge[];
  private readonly nodesById: Map<string, GraphNode>;

  constructor(nodes: GraphNode[], edges: GraphEdge[]) {
    this.nodes = nodes;
    this.edges = edges;
    this.nodesById = new Map(nodes.map((node) => [node.id, node]));
  }

  static async fromDirectory(graphDirectory: string): Promise<GraphStore> {
    const [nodesText, edgesText] = await Promise.all([
      readFile(join(graphDirectory, "nodes.json"), "utf8"),
      readFile(join(graphDirectory, "edges.json"), "utf8"),
    ]);
    return new GraphStore(JSON.parse(nodesText) as GraphNode[], JSON.parse(edgesText) as GraphEdge[]);
  }

  get nodeCount(): number {
    return this.nodes.length;
  }

  get edgeCount(): number {
    return this.edges.length;
  }

  findNode(nameOrId: string): GraphNode | undefined {
    const direct = this.nodesById.get(nameOrId);
    if (direct) return direct;
    const normalized = nameOrId.trim().toLocaleLowerCase("ko-KR");
    return this.nodes.find((node) => node.name.toLocaleLowerCase("ko-KR") === normalized);
  }

  traverse(startName: string, path: GraphHop[], maxNodes = 20): GraphTraversalResult {
    return this.query({ startName, path, maxNodes });
  }

  query(input: GraphStep["input"]): GraphTraversalResult {
    const starts = this.selectStarts(input);
    if (starts.length === 0) {
      const label = input.startName ?? `${input.startType ?? "unknown"} ${JSON.stringify(input.startWhere ?? {})}`;
      throw new Error(`그래프 시작 개체를 찾을 수 없습니다: ${label}`);
    }

    if (input.mode === "rank") {
      const hop = input.path[0];
      if (!hop) throw new Error("관계 집계에는 하나의 관계가 필요합니다.");
      const ranking = starts
        .map((node) => ({
          node,
          count: this.edges.filter((edge) =>
            edge.relation === hop.relation
            && (hop.direction === "out" ? edge.source === node.id : edge.target === node.id)
          ).length,
        }))
        .sort((left, right) => right.count - left.count || left.node.name.localeCompare(right.node.name, "ko-KR"))
        .slice(0, input.maxNodes ?? 20);
      return {
        mode: "rank",
        start: starts[0],
        starts,
        paths: [],
        resultNodes: ranking.map((item) => item.node),
        ranking,
      };
    }

    let frontier: FrontierItem[] = starts.map((node) => ({ node, nodes: [node], edges: [] }));

    for (const hop of input.path) {
      const next: FrontierItem[] = [];
      for (const item of frontier) {
        const matching = this.edges.filter((edge) => {
          if (edge.relation !== hop.relation) return false;
          return hop.direction === "out" ? edge.source === item.node.id : edge.target === item.node.id;
        });

        for (const edge of matching) {
          const targetId = hop.direction === "out" ? edge.target : edge.source;
          const target = this.nodesById.get(targetId);
          if (!target) continue;
          next.push({
            node: target,
            nodes: [...item.nodes, target],
            edges: [...item.edges, edge],
          });
          if (next.length >= (input.maxNodes ?? 20)) break;
        }
        if (next.length >= (input.maxNodes ?? 20)) break;
      }
      frontier = next;
      if (frontier.length === 0) break;
    }

    const resultNodes = [...new Map(frontier.map((item) => [item.node.id, item.node])).values()];
    return {
      mode: "traverse",
      start: starts[0],
      starts,
      paths: frontier.map((item) => ({ nodes: item.nodes, edges: item.edges })),
      resultNodes,
    };
  }

  private selectStarts(input: GraphStep["input"]): GraphNode[] {
    if (input.startName) {
      const start = this.findNode(input.startName);
      return start ? [start] : [];
    }

    return this.nodes.filter((node) => {
      if (input.startType && node.type !== input.startType) return false;
      return Object.entries(input.startWhere ?? {}).every(([key, value]) => node.properties[key] === value);
    });
  }
}
