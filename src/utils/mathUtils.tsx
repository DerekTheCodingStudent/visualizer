import type { Quad, Rect } from "../types";

// Utility : AABB intersection / containment
export function rectIntersects(a: Rect, b: Rect): boolean {
    return !(
        a.x + a.w <= b.x ||
        b.x + b.w <= a.x ||
        a.y + a.h <= b.y ||
        b.y + b.h <= a.y
    );
}
export function rectContains(a: Rect, b: Rect): boolean {
    // does A fully contain B?
    return (
        a.x <= b.x &&
        a.y <= b.y &&
        a.x + a.w >= b.x + b.w &&
        a.y + a.h >= b.y + b.h
    );
}
// Compute view rectangle in *world* coordinates from uniforms used in vertex shader
// Shader does: position' = (pos + u_translation) * u_scale
// then position' must be in [-u_resolution/2, u_resolution/2] to be inside the viewport
export function computeViewRect(
    u_resolution: { x: number; y: number },
    u_translation: { x: number; y: number },
    u_scale: number,
): Rect {
    const halfW = u_resolution.x / (2 * u_scale);
    const halfH = u_resolution.y / (2 * u_scale);

    const left = -halfW - u_translation.x;
    const right = halfW - u_translation.x;
    const top = -halfH - u_translation.y;
    const bottom = halfH - u_translation.y;

    return { x: left, y: top, w: right - left, h: bottom - top };
}

export type BBox = {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    w: number;
    h: number;
};

export function computeBoundingBox(
    quads: Pick<Quad, "x" | "y" | "w" | "h">[],
): BBox | null {
    if (quads.length === 0) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const q of quads) {
        minX = Math.min(minX, q.x);
        minY = Math.min(minY, q.y);
        maxX = Math.max(maxX, q.x + q.w);
        maxY = Math.max(maxY, q.y + q.h);
    }

    return {
        minX,
        minY,
        maxX,
        maxY,
        w: maxX - minX,
        h: maxY - minY,
    };
}

/** Linear map each quad from axis-aligned `src` to `dest` (same corner semantics: x,y = min corner, w,h = extents). */
export function remapQuadsToBoundingBox(
    quads: Quad[],
    src: BBox,
    dest: BBox,
): Quad[] {
    if (src.w <= 0 || src.h <= 0) return quads;

    const sx = dest.w / src.w;
    const sy = dest.h / src.h;

    return quads.map((q) => ({
        ...q,
        x: dest.minX + (q.x - src.minX) * sx,
        y: dest.minY + (q.y - src.minY) * sy,
        w: q.w * sx,
        h: q.h * sy,
    }));
}

/** Fixed plot region in world space (must match border quad in App). */
export const CHART_PLOT = {
    cx: 0,
    cy: 0,
    halfWidth: 300,
    top: 100,
    bottom: -200,
} as const;

export function getChartPlotBBox(): BBox {
    const { cx, cy, halfWidth, top, bottom } = CHART_PLOT;
    const minX = cx - halfWidth;
    const maxX = cx + halfWidth;
    const minY = cy + bottom;
    const maxY = cy + top;
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

export function mapPointBetweenBBoxes(
    px: number,
    py: number,
    src: BBox,
    dest: BBox,
): { x: number; y: number } {
    if (src.w <= 0 || src.h <= 0) return { x: px, y: py };
    const sx = dest.w / src.w;
    const sy = dest.h / src.h;
    return {
        x: dest.minX + (px - src.minX) * sx,
        y: dest.minY + (py - src.minY) * sy,
    };
}

/** Map a data-space X coordinate into plot-world X using the same linear scale as the quads. */
export function mapDataXToPlotWorld(
    dataX: number,
    src: BBox,
    dest: BBox,
): number {
    if (src.w <= 0) return dataX;
    return dest.minX + (dataX - src.minX) * (dest.w / src.w);
}

/** Map a data-space Y coordinate into plot-world Y using the same linear scale as the quads. */
export function mapDataYToPlotWorld(
    dataY: number,
    src: BBox,
    dest: BBox,
): number {
    if (src.h <= 0) return dataY;
    return dest.minY + (dataY - src.minY) * (dest.h / src.h);
}
