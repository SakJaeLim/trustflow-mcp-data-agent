import { join } from "node:path";
import type { GraphHop, GraphStep } from "../core/model.ts";
import { readRegularFileBounded } from "../core/safe-file.ts";
import type { CompanyXIntegrity } from "../core/companyx-integrity.ts";

const MAX_GRAPH_FILE_BYTES = 8 * 1_048_576;
const MAX_GRAPH_NODES = 1_000;
const MAX_GRAPH_EDGES = 10_000;
const MAX_GRAPH_PROPERTIES_BYTES = 16_384;

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
  private readonly outgoing: Map<string, GraphEdge[]>;
  private readonly incoming: Map<string, GraphEdge[]>;
  readonly datasetSha256?: string;

  constructor(nodes: GraphNode[], edges: GraphEdge[], datasetSha256?: string) {
    this.nodes = nodes;
    this.edges = edges;
    this.nodesById = new Map(nodes.map((node) => [node.id, node]));
    this.outgoing = new Map();
    this.incoming = new Map();
    this.datasetSha256 = datasetSha256;
    for (const edge of edges) {
      const outgoingKey = this.edgeKey(edge.relation, edge.source);
      const incomingKey = this.edgeKey(edge.relation, edge.target);
      this.outgoing.set(outgoingKey, [...(this.outgoing.get(outgoingKey) ?? []), edge]);
      this.incoming.set(incomingKey, [...(this.incoming.get(incomingKey) ?? []), edge]);
    }
  }

  static async fromDirectory(graphDirectory: string, datasetSha256?: string): Promise<GraphStore> {
    const [nodesText, edgesText] = await Promise.all([
      readRegularFileBounded(join(graphDirectory, "nodes.json"), MAX_GRAPH_FILE_BYTES),
      readRegularFileBounded(join(graphDirectory, "edges.json"), MAX_GRAPH_FILE_BYTES),
    ]);
    const nodes = parseNodes(JSON.parse(nodesText.bytes.toString("utf8")) as unknown);
    const edges = parseEdges(JSON.parse(edgesText.bytes.toString("utf8")) as unknown, new Set(nodes.map((node) => node.id)));
    return new GraphStore(nodes, edges, datasetSha256);
  }

  static fromIntegrity(integrity: CompanyXIntegrity): GraphStore {
    const nodeBytes = integrity.readFile("graph/nodes.json");
    const edgeBytes = integrity.readFile("graph/edges.json");
    if (nodeBytes.byteLength > MAX_GRAPH_FILE_BYTES || edgeBytes.byteLength > MAX_GRAPH_FILE_BYTES) {
      throw new Error(`Graph files must not exceed ${MAX_GRAPH_FILE_BYTES} bytes.`);
    }
    const nodes = parseNodes(JSON.parse(nodeBytes.toString("utf8")) as unknown);
    const edges = parseEdges(
      JSON.parse(edgeBytes.toString("utf8")) as unknown,
      new Set(nodes.map((node) => node.id)),
    );
    return new GraphStore(nodes, edges, integrity.datasetSha256);
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
          count: this.matchingEdges(node.id, hop).length,
        }))
        .sort((left, right) => right.count - left.count || left.node.name.localeCompare(right.node.name, "ko-KR"))
        .slice(0, input.maxNodes ?? 20);
      return {
        mode: "rank",
        start: ranking[0]?.node,
        starts: ranking.map((item) => item.node),
        paths: [],
        resultNodes: ranking.map((item) => item.node),
        ranking,
      };
    }

    const boundedStarts = starts.slice(0, input.maxNodes ?? 20);
    let frontier: FrontierItem[] = boundedStarts.map((node) => ({ node, nodes: [node], edges: [] }));

    for (const hop of input.path) {
      const next: FrontierItem[] = [];
      for (const item of frontier) {
        const matching = this.matchingEdges(item.node.id, hop);

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
      start: boundedStarts[0],
      starts: boundedStarts,
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

  private edgeKey(relation: string, nodeId: string): string {
    return `${relation}\0${nodeId}`;
  }

  private matchingEdges(nodeId: string, hop: GraphHop): GraphEdge[] {
    return (hop.direction === "out" ? this.outgoing : this.incoming).get(this.edgeKey(hop.relation, nodeId)) ?? [];
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validProperties(value: unknown): value is Record<string, unknown> {
  const properties = record(value);
  return Boolean(properties) && Buffer.byteLength(JSON.stringify(properties), "utf8") <= MAX_GRAPH_PROPERTIES_BYTES;
}

function parseNodes(value: unknown): GraphNode[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_GRAPH_NODES) {
    throw new Error(`Graph nodes must contain 1-${MAX_GRAPH_NODES} entries.`);
  }
  const nodes = value.map((item, index) => {
    const node = record(item);
    if (!node
      || typeof node.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(node.id)
      || typeof node.type !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(node.type)
      || typeof node.name !== "string" || !node.name.trim() || Buffer.byteLength(node.name, "utf8") > 1_024
      || !validProperties(node.properties)) throw new Error(`Invalid graph node ${index}.`);
    return { id: node.id, type: node.type, name: node.name, properties: node.properties };
  });
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) throw new Error("Graph contains duplicate node IDs.");
  return nodes;
}

function parseEdges(value: unknown, nodeIds: Set<string>): GraphEdge[] {
  if (!Array.isArray(value) || value.length > MAX_GRAPH_EDGES) {
    throw new Error(`Graph edges must contain at most ${MAX_GRAPH_EDGES} entries.`);
  }
  return value.map((item, index) => {
    const edge = record(item);
    if (!edge
      || typeof edge.source !== "string" || !nodeIds.has(edge.source)
      || typeof edge.target !== "string" || !nodeIds.has(edge.target)
      || typeof edge.relation !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(edge.relation)
      || (edge.properties !== undefined && !validProperties(edge.properties))) {
      throw new Error(`Invalid graph edge ${index}.`);
    }
    return {
      source: edge.source,
      target: edge.target,
      relation: edge.relation,
      properties: edge.properties as Record<string, unknown> | undefined,
    };
  });
}
