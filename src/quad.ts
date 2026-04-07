import {Quad, BBox, Box} from "util/MathUtils.tsx"

function fitPointToBox(
  x: number,
  y: number,
  src: BBox,
  dst: Box,
  preserveAspect = false
) {
  if (src.w === 0 || src.h === 0) {
    return { x: dst.x, y: dst.y };
  }

  const sx = dst.w / src.w;
  const sy = dst.h / src.h;

  if (!preserveAspect) {
    return {
      x: dst.x + (x - src.minX) * sx,
      y: dst.y + (y - src.minY) * sy,
    };
  }

  const s = Math.min(sx, sy);
  const usedW = src.w * s;
  const usedH = src.h * s;

  const padX = (dst.w - usedW) * 0.5;
  const padY = (dst.h - usedH) * 0.5;

  return {
    x: dst.x + padX + (x - src.minX) * s,
    y: dst.y + padY + (y - src.minY) * s,
  };
}

function transformQuad(
  q: Quad,
  src: BBox,
  dst: Box,
  preserveAspect = false
): Quad {
  const p0 = fitPointToBox(q.x, q.y, src, dst, preserveAspect);
  const p1 = fitPointToBox(q.x + q.w, q.y + q.h, src, dst, preserveAspect);

  return {
    x: p0.x,
    y: p0.y,
    w: p1.x - p0.x,
    h: p1.y - p0.y,
    color: q.color,
  };
}
