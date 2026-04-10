import type { Rect, Quad } from "../types";
import { rectIntersects, rectContains, pointInRect } from "./mathUtils";

// Quadtree node
export class QuadNode {
    bounds: Rect;
    indices: number[] = []; // indices of base quads that are stored in this node
    children: QuadNode[] | null = null;
    depth: number;

    constructor(bounds: Rect, depth = 0) {
        this.bounds = bounds;
        this.depth = depth;
    }
}

// Build quadtree from base quads array
export function buildQuadTree(
    baseQuads: Quad[],
    options?: {
        maxDepth?: number;
        capacity?: number;
        rootBounds?: Rect;
    },
) {
    const maxDepth = options?.maxDepth ?? 10;
    const capacity = options?.capacity ?? 8;

    // compute root bounds if not provided
    let rootBounds = options?.rootBounds;
    if (!rootBounds) {
        if (baseQuads.length === 0) rootBounds = { x: 0, y: 0, w: 0, h: 0 };
        else {
            let minX = Infinity,
                minY = Infinity,
                maxX = -Infinity,
                maxY = -Infinity;
            baseQuads.forEach((q) => {
                minX = Math.min(minX, q.x);
                minY = Math.min(minY, q.y);
                maxX = Math.max(maxX, q.x + q.w);
                maxY = Math.max(maxY, q.y + q.h);
            });
            rootBounds = {
                x: minX,
                y: minY,
                w: Math.max(1e-6, maxX - minX),
                h: Math.max(1e-6, maxY - minY),
            };
        }
    }

    const root = new QuadNode(rootBounds, 0);

    function subdivide(node: QuadNode) {
        const { x, y, w, h } = node.bounds;
        const hw = w / 2;
        const hh = h / 2;
        node.children = [
            new QuadNode({ x: x, y: y, w: hw, h: hh }, node.depth + 1), // top-left
            new QuadNode({ x: x + hw, y: y, w: hw, h: hh }, node.depth + 1), // top-right
            new QuadNode({ x: x, y: y + hh, w: hw, h: hh }, node.depth + 1), // bottom-left
            new QuadNode(
                { x: x + hw, y: y + hh, w: hw, h: hh },
                node.depth + 1,
            ), // bottom-right
        ];
    }

    function tryInsert(node: QuadNode, quadIndex: number) {
        const quad = baseQuads[quadIndex];
        const qRect = { x: quad.x, y: quad.y, w: quad.w, h: quad.h };

        // If node has children, attempt to push it down into a single child that fully contains it.
        if (node.children) {
            for (const child of node.children) {
                if (rectContains(child.bounds, qRect)) {
                    tryInsert(child, quadIndex);
                    return;
                }
            }
            // otherwise it does not fully fit into any single child -> keep in current node
            node.indices.push(quadIndex);
            return;
        }

        // if leaf: store
        node.indices.push(quadIndex);

        // split if capacity exceeded and not at max depth
        if (node.indices.length > capacity && node.depth < maxDepth) {
            subdivide(node);
            // re-distribute
            const toReinsert = node.indices.slice();
            node.indices.length = 0;
            toReinsert.forEach((idx) => tryInsert(node, idx));
        }
    }

    // Insert all quads
    for (let i = 0; i < baseQuads.length; i++) tryInsert(root, i);

    return root;
}

// Query: returns indices of baseQuads (only from leaf nodes) that intersect viewRect
export function queryVisibleIndices(
    root: QuadNode,
    baseQuads: Quad[],
    viewRect: Rect,
) {
    const out: number[] = [];

    function visit(node: QuadNode) {
        if (!rectIntersects(node.bounds, viewRect)) return; // node fully outside

        // If node fully inside view, we can gather all indices in this subtree quickly:
        if (rectContains(viewRect, node.bounds)) {
            // collect all indices from leaves under this node without per-quad intersection tests
            collectAllLeafIndices(node);
            return;
        }

        // Partial intersection -> either dive into children or check leaf indices individually
        if (node.children) {
            node.children.forEach(visit);
        }
        if (node.indices) {
            // node is leaf: check each stored quad against the view
            for (const idx of node.indices) {
                const q = baseQuads[idx];
                if (
                    rectIntersects(viewRect, { x: q.x, y: q.y, w: q.w, h: q.h })
                )
                    out.push(idx);
            }
        }
    }

    function collectAllLeafIndices(node: QuadNode) {
        if (node.children) {
            node.children.forEach(collectAllLeafIndices);
        } else {
            // leaf: add every index (no per-quad test)
            out.push(...node.indices);
        }
    }

    visit(root);
    // Remove duplicates (just in case) and return
    return Array.from(new Set(out));
}

export function findQuadAt(
    node: QuadNode,
    baseQuads: Quad[],
    px: number,
    py: number
): Quad | null {
    // If point is not in this node's bounds, skip
    if (!pointInRect(px, py, node.bounds)) return null;

    // Check quads stored in this node
    for (const idx of node.indices) {
        const q = baseQuads[idx];
        if (pointInRect(px, py, { x: q.x, y: q.y, w: q.w, h: q.h })) {
            return q;
        }
    }

    // Check children
    if (node.children) {
        for (const child of node.children) {
            const found = findQuadAt(child, baseQuads, px, py);
            if (found) return found;
        }
    }

    return null;
}