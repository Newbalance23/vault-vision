export function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

export function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function pointConfidence(point) {
  if (!point) return 0;
  const visibility = point.visibility ?? point.presence ?? point.score ?? 1;
  return clamp(Number.isFinite(visibility) ? visibility : 0);
}

export function averageConfidence(landmarks = [], indexes = []) {
  const selected = indexes.map((index) => landmarks[index]).filter(Boolean);
  if (!selected.length) return 0;
  return selected.reduce((sum, point) => sum + pointConfidence(point), 0) / selected.length;
}

export function distance(a, b) {
  if (!a || !b) return null;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function midpoint(a, b) {
  if (!a || !b) return null;
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: ((a.z ?? 0) + (b.z ?? 0)) / 2,
    visibility: Math.min(pointConfidence(a), pointConfidence(b)),
  };
}

export function angleBetween(a, b, c) {
  if (!a || !b || !c) return null;
  const ab = { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) };
  const cb = { x: c.x - b.x, y: c.y - b.y, z: (c.z ?? 0) - (b.z ?? 0) };
  const dot = ab.x * cb.x + ab.y * cb.y + ab.z * cb.z;
  const abLen = Math.sqrt(ab.x * ab.x + ab.y * ab.y + ab.z * ab.z);
  const cbLen = Math.sqrt(cb.x * cb.x + cb.y * cb.y + cb.z * cb.z);
  if (!abLen || !cbLen) return null;
  return (Math.acos(clamp(dot / (abLen * cbLen), -1, 1)) * 180) / Math.PI;
}

export function segmentAngleDegrees(a, b) {
  if (!a || !b) return null;
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

export function boundingBox(landmarks = []) {
  const valid = landmarks.filter((point) => point && pointConfidence(point) > 0.2);
  if (!valid.length) return null;
  const xs = valid.map((point) => point.x);
  const ys = valid.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    area: (maxX - minX) * (maxY - minY),
  };
}

export function movingAverage(values, radius = 2) {
  return values.map((_, index) => {
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length, index + radius + 1);
    const window = values.slice(start, end).filter((value) => Number.isFinite(value));
    if (!window.length) return null;
    return window.reduce((sum, value) => sum + value, 0) / window.length;
  });
}

export function firstIndexAfter(values, start, predicate) {
  for (let index = Math.max(0, start); index < values.length; index += 1) {
    if (predicate(values[index], index)) return index;
  }
  return -1;
}
