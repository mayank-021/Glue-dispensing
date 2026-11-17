import React from 'react';

export const SPC_KEY = 'spcDotQuality';
const SPC_MAX_JOBS = 60;

export function idwCorrect(x, y, vectors, power = 2) {
  if (!vectors || !vectors.length) return { dx: 0, dy: 0 };
  let wdx = 0, wdy = 0, wsum = 0;
  for (const v of vectors) {
    const d2 = (x - v.x) * (x - v.x) + (y - v.y) * (y - v.y);
    if (d2 < 1e-6) return { dx: v.dx, dy: v.dy };
    const w = 1 / Math.pow(d2, power);
    wdx += w * v.dx; wdy += w * v.dy; wsum += w;
  }
  return { dx: wdx / wsum, dy: wdy / wsum };
}

export function spcLoad() {
  try { return JSON.parse(localStorage.getItem(SPC_KEY) || '{"jobs":[]}'); }
  catch { return { jobs: [] }; }
}

export function spcAppend(dotResults, totalPads) {
  if (!dotResults || dotResults.length === 0) return;
  const data = spcLoad();
  const passed = dotResults.filter(r => r.passed).length;
  const diams = dotResults.filter(r => r.diameter_mm > 0).map(r => r.diameter_mm);
  data.jobs = [...data.jobs, {
    jobId: new Date().toISOString(), date: new Date().toLocaleDateString(), totalPads,
    checked: dotResults.length, passed, failed: dotResults.length - passed,
    passRate: passed / dotResults.length,
    avgDiameter: diams.length ? diams.reduce((a, b) => a + b, 0) / diams.length : null,
    minDiameter: diams.length ? Math.min(...diams) : null,
  }].slice(-SPC_MAX_JOBS);
  localStorage.setItem(SPC_KEY, JSON.stringify(data));
}

export function parsePnpCsv(text, filename = '') {
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
  if (lines.length < 2) return [];
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(delim).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const findCol = (...names) => names.reduce((found, name) => found >= 0 ? found : headers.findIndex(h => h.includes(name)), -1);
  const colRef = findCol('ref', 'designator', 'reference');
  const colX = findCol('pos x', 'mid x', 'posx', 'x');
  const colY = findCol('pos y', 'mid y', 'posy', 'y');
  const colPkg = findCol('package', 'footprint', 'value', 'val');
  const colSide = findCol('side', 'layer');
  const colRot = findCol('rot', 'rotation', 'angle');
  if (colX < 0 || colY < 0) return [];
  const fn = filename.toLowerCase();
  const filenameSide = fn.includes('bot') || fn.includes('back') || fn.includes('-b.') || fn.includes('_b.') ? 'bottom' : 'top';
  const parseNum = s => parseFloat(String(s).replace(/[^\d.\-]/g, '') || '0');
  const resolveSide = raw => {
    if (!raw) return filenameSide;
    const r = raw.toLowerCase().trim();
    if (r === 'f.cu' || r === 'f' || r === 'front' || r === 'top') return 'top';
    if (r === 'b.cu' || r === 'b' || r === 'back' || r.includes('bot')) return 'bottom';
    return filenameSide;
  };
  return lines.slice(1).map((line, i) => {
    const cols = line.split(delim).map(c => c.trim().replace(/^"|"$/g, ''));
    const x = parseNum(cols[colX]), y = parseNum(cols[colY]);
    if (isNaN(x) || isNaN(y)) return null;
    return { id: colRef >= 0 ? cols[colRef] : `C${i + 1}`, x, y,
      pkg: colPkg >= 0 ? cols[colPkg] : '', side: resolveSide(colSide >= 0 ? cols[colSide] : null),
      rotation: colRot >= 0 ? parseNum(cols[colRot]) : 0 };
  }).filter(Boolean);
}

export function detectDnpComponents(comps) {
  const dnpKeywords = ['dnp', 'do not place', 'no fit', 'not fit', 'nf', 'nc', 'nm', 'x'];
  return new Set(comps.filter(c => {
    if (/^(fid|f\d+|fd\d+)/i.test(c.id || '') || /fiducial/i.test(c.pkg || '') || /fiducial/i.test(c.val || '') || /fid/i.test(c.desc || '')) return true;
    const pkg = (c.pkg || '').toLowerCase().trim();
    return pkg === '' || dnpKeywords.some(kw => pkg === kw || pkg.startsWith(kw + ' '));
  }).map(c => c.id));
}

export function autoComputePnpOffset(csvComponents, appFiducials, toleranceMm = 5) {
  const isFid = c => /^(fid|f\d+|fd\d+)/i.test(c.id || '') || /fiducial/i.test(c.pkg || '') || /fiducial/i.test(c.val || '') || /fid/i.test(c.desc || '');
  const csvFids = csvComponents.filter(isFid);
  const appDesign = (appFiducials || [])
    .map(f => f.design ? f.design : (typeof f.x === 'number' && typeof f.y === 'number' ? { x: f.x, y: f.y } : null))
    .filter(Boolean);
  if (!csvFids.length || !appDesign.length) return null;

  let bestScore = 0, bestOffset = null;

  for (const flipY of [false, true]) {
    for (const cf of csvFids) {
      const cfY = flipY ? -cf.y : cf.y;
      for (const af of appDesign) {
        const candDx = af.x - cf.x;
        const candDy = af.y - cfY;
        let sumDx = 0, sumDy = 0, matches = 0;
        for (const cf2 of csvFids) {
          const cf2Y = flipY ? -cf2.y : cf2.y;
          const sx = cf2.x + candDx;
          const sy = cf2Y + candDy;
          let minDist = Infinity, bestAf = null;
          for (const af2 of appDesign) {
            const d = Math.hypot(af2.x - sx, af2.y - sy);
            if (d < minDist) { minDist = d; bestAf = af2; }
          }
          if (minDist < toleranceMm) {
            sumDx += bestAf.x - cf2.x;
            sumDy += bestAf.y - cf2Y;
            matches++;
          }
        }
        if (matches > bestScore) {
          bestScore = matches;
          bestOffset = { x: sumDx / matches, y: sumDy / matches, flipY, matches };
        }
      }
    }
  }
  return bestOffset;
}

export function classifyDotPattern(pkg) {
  if (!pkg) return 'outline';
  return 'outline';
}

export const PACKAGE_DIMENSIONS = {
  // Standard chip passives (mm)
  '0201': { width: 0.6, height: 0.3 },
  '0402': { width: 1.0, height: 0.5 },
  '0603': { width: 1.6, height: 0.8 },
  '0805': { width: 2.0, height: 1.25 },
  '1206': { width: 3.2, height: 1.6 },
  '1210': { width: 3.2, height: 2.5 },
  '1812': { width: 4.5, height: 3.2 },
  '2010': { width: 5.0, height: 2.5 },
  '2512': { width: 6.3, height: 3.2 },
  // Transistors & Diodes
  'sot23': { width: 2.9, height: 1.6 },
  'sot-23': { width: 2.9, height: 1.6 },
  'sot89': { width: 4.5, height: 2.5 },
  'sot-89': { width: 4.5, height: 2.5 },
  'sot223': { width: 6.5, height: 3.5 },
  'sot-223': { width: 6.5, height: 3.5 },
  'sod123': { width: 2.7, height: 1.6 },
  'sod-123': { width: 2.7, height: 1.6 },
  'sod323': { width: 1.7, height: 1.25 },
  'sod-323': { width: 1.7, height: 1.25 },
  'sma': { width: 4.5, height: 2.6 },
  'smb': { width: 5.4, height: 3.6 },
  'smc': { width: 7.9, height: 5.9 },
  // Optocouplers / SOP-4 style (VO1 footprints)
  'sop-4': { width: 4.6, height: 6.5 },
  'sop4': { width: 4.6, height: 6.5 },
  'so-4': { width: 4.6, height: 6.5 },
  'so4': { width: 4.6, height: 6.5 },
  // IC packages
  'soic-8': { width: 4.9, height: 3.9 },
  'soic8': { width: 4.9, height: 3.9 },
  'so-8': { width: 4.9, height: 3.9 },
  'soic-14': { width: 8.65, height: 3.9 },
  'soic-16': { width: 9.9, height: 3.9 },
  'tssop-8': { width: 3.0, height: 4.4 },
  'tssop-14': { width: 5.0, height: 4.4 },
  'tssop-16': { width: 5.0, height: 4.4 },
  'qfn-16': { width: 4.0, height: 4.0 },
  'qfn-20': { width: 4.0, height: 4.0 },
  'qfn-28': { width: 5.0, height: 5.0 },
  'qfn-32': { width: 5.0, height: 5.0 },
  'lqfp-32': { width: 7.0, height: 7.0 },
  'lqfp-48': { width: 7.0, height: 7.0 },
  'lqfp-64': { width: 10.0, height: 10.0 },
};

function _median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Bounding box of copper pads for ONE component body.
 * Uses pad centres for span, then adds a capped pad half-size — avoids huge Gerber
 * apertures inflating the outline across neighboring parts.
 */
export function computePadsBoundingBox(pads) {
  if (!pads || pads.length === 0) return null;
  const pts = pads.filter(p => typeof p.x === 'number' && typeof p.y === 'number');
  if (!pts.length) return null;

  const halfSizes = pts.map(p => {
    const w = Number(p.width);
    const h = Number(p.height);
    // Ignore absurd aperture sizes (>3mm half) — treat as 0.4mm flash
    const hw = (Number.isFinite(w) && w > 0 && w < 6) ? w / 2 : 0.35;
    const hh = (Number.isFinite(h) && h > 0 && h < 6) ? h / 2 : 0.35;
    return Math.max(hw, hh);
  });
  const padPad = Math.min(0.9, Math.max(0.2, _median(halfSizes)));

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  let width = (maxX - minX) + 2 * padPad;
  let height = (maxY - minY) + 2 * padPad;

  // Safety cap so one outline never spans a whole neighborhood of parts
  const maxLong = pts.length <= 2 ? 5.5 : pts.length <= 4 ? 8.0 : pts.length <= 8 ? 11.0 : 14.0;
  const long = Math.max(width, height);
  if (long > maxLong) {
    const scale = maxLong / long;
    width *= scale;
    height *= scale;
  }

  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    width: Math.max(0.4, width),
    height: Math.max(0.4, height),
  };
}

/**
 * Split a pad list into proximity clusters so a shared/wrong refdes cannot
 * pull neighboring components into one giant outline.
 */
function splitPadsByProximity(pads) {
  if (!pads || pads.length <= 1) return [pads || []];

  const nnds = pads.map((p, i) => {
    let best = Infinity;
    for (let j = 0; j < pads.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(p.x - pads[j].x, p.y - pads[j].y);
      if (d < best) best = d;
    }
    return best;
  }).filter(d => Number.isFinite(d));
  const medNN = _median(nnds) || 1.2;
  // Bridge opposite sides of small ICs (~4–6mm) but not separate nearby discretes
  const linkDist = Math.min(6.5, Math.max(2.8, medNN * 2.8));

  const parent = pads.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const unite = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

  for (let i = 0; i < pads.length; i++) {
    for (let j = i + 1; j < pads.length; j++) {
      if (Math.hypot(pads[i].x - pads[j].x, pads[i].y - pads[j].y) <= linkDist) {
        unite(i, j);
      }
    }
  }

  const buckets = new Map();
  pads.forEach((p, i) => {
    const r = find(i);
    if (!buckets.has(r)) buckets.set(r, []);
    buckets.get(r).push(p);
  });
  return [...buckets.values()];
}

/**
 * Collapse Gerber copper flashes into ONE component per refdes (TO.C,xxx).
 * Pads without a shared identifier stay as single-pad components.
 * Outline size = tight bounding box of that component's pads only.
 */
export function groupPadsIntoComponents(pads) {
  if (!pads || pads.length === 0) return [];

  const groups = new Map();
  const singles = [];

  for (const p of pads) {
    const rawKey = (p.componentIdentifier || p.id || '').toString().trim();
    // Synthetic ids like P12 are not real refdes — treat as lone pads
    const isSynthetic = !rawKey || /^P\d+$/i.test(rawKey) || /_SR\d+_\d+$/i.test(rawKey);
    if (isSynthetic) {
      singles.push(p);
      continue;
    }
    const key = rawKey;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const components = [];

  const pushCluster = (id, memberPads, idSuffix = '') => {
    const bbox = computePadsBoundingBox(memberPads);
    if (!bbox) return;
    const seed = memberPads[0];
    const cid = idSuffix ? `${id}${idSuffix}` : id;
    components.push({
      ...seed,
      id: cid,
      componentIdentifier: id,
      x: bbox.x,
      y: bbox.y,
      width: bbox.width,
      height: bbox.height,
      memberPads,
      padCount: memberPads.length,
      shape: 'rect',
      centerValid: true,
      centerMethod: memberPads.length > 1 ? 'pad_group_bbox' : (seed.centerMethod || 'gerber_flash_center'),
      originalPad: seed.originalPad || seed,
    });
  };

  for (const [id, memberPads] of groups) {
    const clusters = splitPadsByProximity(memberPads);
    if (clusters.length === 1) {
      pushCluster(id, clusters[0]);
    } else {
      // Same refdes but spatially separate → keep as separate outlines (avoid 2–3 part mega-box)
      clusters
        .sort((a, b) => b.length - a.length)
        .forEach((cl, idx) => pushCluster(id, cl, clusters.length > 1 ? `#${idx + 1}` : ''));
    }
  }

  for (const p of singles) {
    const bbox = computePadsBoundingBox([p]);
    // Single flash: never let a bad aperture create a multi-component-sized box
    const w = Math.min(bbox ? bbox.width : (p.width || 1), 3.2);
    const h = Math.min(bbox ? bbox.height : (p.height || 1), 3.2);
    components.push({
      ...p,
      id: p.id || p.componentIdentifier || `P${components.length + 1}`,
      width: w,
      height: h,
      x: bbox ? bbox.x : p.x,
      y: bbox ? bbox.y : p.y,
      memberPads: [p],
      padCount: 1,
      shape: p.shape || 'rect',
    });
  }

  return components;
}

export function getComponentDimensions(comp) {
  if (!comp) return { width: 2.0, height: 1.25 };

  // 0. Prefer pad-cluster bbox (multi-pad footprint → full component body)
  const members = comp.memberPads || comp.pads;
  if (Array.isArray(members) && members.length >= 2) {
    const bbox = computePadsBoundingBox(members);
    if (bbox) return { width: bbox.width, height: bbox.height };
  }

  // 1. Explicit body size already computed as a multi-pad / enriched footprint
  if (comp.padCount >= 2 && typeof comp.width === 'number' && comp.width > 0.2
      && typeof comp.height === 'number' && comp.height > 0.2) {
    return { width: comp.width, height: comp.height };
  }

  const pkg = (comp.pkg || comp.package || comp.footprint || '').toLowerCase().trim();

  // 2. Direct package lookup
  if (pkg && PACKAGE_DIMENSIONS[pkg]) {
    return { ...PACKAGE_DIMENSIONS[pkg] };
  }

  // 3. Regex match for standard chip passives in footprint name
  if (pkg) {
    const chipMatch = pkg.match(/(?:^|[_\-\s])(0201|0402|0603|0805|1206|1210|1812|2010|2512)(?:[_\-\s]|$)/);
    if (chipMatch && PACKAGE_DIMENSIONS[chipMatch[1]]) {
      return { ...PACKAGE_DIMENSIONS[chipMatch[1]] };
    }

    // 4. Regex for dimension in name like 5x5, 3x3mm, etc.
    const dimMatch = pkg.match(/(\d+(?:\.\d+)?)\s*[xX*]\s*(\d+(?:\.\d+)?)/);
    if (dimMatch) {
      const w = parseFloat(dimMatch[1]);
      const h = parseFloat(dimMatch[2]);
      if (w > 0.2 && h > 0.2) return { width: w, height: h };
    }

    if (/sot-?23/i.test(pkg)) return { width: 2.9, height: 1.6 };
    if (/sot-?89/i.test(pkg)) return { width: 4.5, height: 2.5 };
    if (/sot-?223/i.test(pkg)) return { width: 6.5, height: 3.5 };
    if (/soic-?8|so-?8/i.test(pkg)) return { width: 4.9, height: 3.9 };
    if (/soic-?14/i.test(pkg)) return { width: 8.65, height: 3.9 };
    if (/soic-?16/i.test(pkg)) return { width: 9.9, height: 3.9 };
    if (/sop-?4|so-?4|optocoupler|pc8|ltv|vishay/i.test(pkg)) return { width: 4.6, height: 6.5 };
    if (/qfn|qfp/i.test(pkg)) return { width: 5.0, height: 5.0 };
    if (/sma|do-?214ac/i.test(pkg)) return { width: 4.5, height: 2.6 };
    if (/smb|do-?214aa/i.test(pkg)) return { width: 5.4, height: 3.6 };
  }

  // 5. Direct width/height — clamp so a bad value cannot span neighboring parts
  if (typeof comp.width === 'number' && comp.width > 0.2 && typeof comp.height === 'number' && comp.height > 0.2) {
    const maxLong = (comp.padCount || 1) <= 1 ? 3.2 : (comp.padCount <= 4 ? 8.0 : 12.0);
    let w = comp.width, h = comp.height;
    const long = Math.max(w, h);
    if (long > maxLong) {
      const scale = maxLong / long;
      w *= scale; h *= scale;
    }
    return { width: w, height: h };
  }

  // 6. Mild designator fallback only when size is completely unknown (keep compact)
  const id = String(comp.id || comp.componentIdentifier || '').toUpperCase();
  if (/^VO?\d+/i.test(id) || /^U\d+/i.test(id)) return { width: 3.8, height: 4.6 };
  if (/^Q\d+/i.test(id)) return { width: 2.9, height: 1.6 };

  return { width: 2.0, height: 1.25 };
}

/**
 * Generates outer boundary offsets [{dx, dy}, ...] relative to the component center point (0, 0).
 * Closing vertex is included so traversing the points forms a closed perimeter loop around the component outline.
 * Multi-pad parts: outline follows the copper pad-cluster AABB (one component, edges only).
 */
export function getComponentBoundaryOffsets(comp, options = {}) {
  const { margin = 0 } = options; // flush to body — oversized boxes were covering neighbors

  // Prefer real pad-cluster geometry when available (VO1 / Q1 / multi-pin)
  const members = comp.memberPads || comp.pads;
  if (Array.isArray(members) && members.length >= 2 && typeof comp.x === 'number' && typeof comp.y === 'number') {
    const bbox = computePadsBoundingBox(members);
    if (bbox) {
      const hw = bbox.width / 2 + margin;
      const hh = bbox.height / 2 + margin;
      // Offset AABB centre vs component mid (PnP mid may differ slightly)
      const ox = bbox.x - comp.x;
      const oy = bbox.y - comp.y;
      return [
        { dx: ox - hw, dy: oy - hh },
        { dx: ox + hw, dy: oy - hh },
        { dx: ox + hw, dy: oy + hh },
        { dx: ox - hw, dy: oy + hh },
        { dx: ox - hw, dy: oy - hh },
      ];
    }
  }

  const { width: rawW, height: rawH } = getComponentDimensions(comp);
  const w = Math.max(0.4, rawW + margin * 2);
  const h = Math.max(0.4, rawH + margin * 2);

  const angleRad = ((comp.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(angleRad), sin = Math.sin(angleRad);
  const rot = (dx, dy) => ({ dx: dx * cos - dy * sin, dy: dx * sin + dy * cos });

  const shape = (comp.shape || '').toLowerCase();
  if (shape === 'circle' || shape === 'c') {
    const radius = Math.max(w, h) / 2;
    const numSteps = 16;
    const pts = [];
    for (let i = 0; i <= numSteps; i++) {
      const theta = (2 * Math.PI * i) / numSteps;
      pts.push({
        dx: radius * Math.cos(theta),
        dy: radius * Math.sin(theta)
      });
    }
    return pts;
  }

  // Rectangular outer boundary: 4 corners + closing back to first corner
  const hw = w / 2;
  const hh = h / 2;
  return [
    rot(-hw, -hh), // Corner 1
    rot(+hw, -hh), // Corner 2
    rot(+hw, +hh), // Corner 3
    rot(-hw, +hh), // Corner 4
    rot(-hw, -hh)  // Closed perimeter back to Corner 1
  ];
}

export function calculatePerimeterLength(boundaryOffsets) {
  if (!boundaryOffsets || boundaryOffsets.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < boundaryOffsets.length - 1; i++) {
    const p1 = boundaryOffsets[i];
    const p2 = boundaryOffsets[i + 1];
    total += Math.hypot(p2.dx - p1.dx, p2.dy - p1.dy);
  }
  return total;
}

export function getComponentDotOffsets(comp, spacingMm, customPatterns = {}) {
  // Backward compatibility: delegates to outer boundary
  return getComponentBoundaryOffsets(comp);
}

export function detectPanelFromFiducials(fiducials) {
  if (!fiducials || !Array.isArray(fiducials)) return null;

  const getPos = f => {
    if (f.design && typeof f.design.x === 'number' && typeof f.design.y === 'number') {
      return { x: f.design.x, y: f.design.y };
    }
    if (typeof f.x === 'number' && typeof f.y === 'number') {
      return { x: f.x, y: f.y };
    }
    return null;
  };

  // Exclude rail fiducials (which sit on external waste strips)
  const valid = fiducials
    .map(f => ({ ...f, pos: getPos(f) }))
    .filter(f => f.pos && !f.isRail && !/^R\d+/i.test(f.id || '') && !/rail/i.test(f.id || ''));

  if (valid.length < 4) return null;

  // 1. Column step detection (fiducials with similar Y, distinct X)
  const colDxs = [];
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const dy = Math.abs(valid[j].pos.y - valid[i].pos.y);
      const dx = Math.abs(valid[j].pos.x - valid[i].pos.x);
      if (dy < 2.5 && dx > 8) {
        colDxs.push(dx);
      }
    }
  }

  // 2. Row step detection (fiducials with similar X, distinct Y)
  const rowDys = [];
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const dx = Math.abs(valid[j].pos.x - valid[i].pos.x);
      const dy = Math.abs(valid[j].pos.y - valid[i].pos.y);
      if (dx < 2.5 && dy > 8) {
        rowDys.push(dy);
      }
    }
  }

  const getFundStep = (steps) => {
    if (!steps.length) return 0;
    const clusters = [];
    for (const s of steps) {
      let cl = clusters.find(c => Math.abs(c.mean - s) < 2.5);
      if (cl) {
        cl.items.push(s);
        cl.mean = cl.items.reduce((a, b) => a + b, 0) / cl.items.length;
      } else {
        clusters.push({ mean: s, items: [s] });
      }
    }
    clusters.sort((a, b) => a.mean - b.mean);
    const validCluster = clusters.find(c => c.items.length >= 2) || clusters[0];
    return validCluster ? parseFloat(validCluster.mean.toFixed(3)) : 0;
  };

  const stepX = getFundStep(colDxs);
  const stepY = getFundStep(rowDys);

  // Group fiducials by modulo phase to determine exact grid rows and columns
  const minX = Math.min(...valid.map(f => f.pos.x));
  const minY = Math.min(...valid.map(f => f.pos.y));

  let cols = 1;
  let rows = 1;

  if (stepX > 5 && stepY > 5) {
    const phases = [];
    for (const f of valid) {
      const px = ((f.pos.x - minX) % stepX + stepX) % stepX;
      const py = ((f.pos.y - minY) % stepY + stepY) % stepY;
      let p = phases.find(ph => Math.hypot(ph.px - px, ph.py - py) < 3.0);
      if (!p) {
        p = { px, py, fids: [] };
        phases.push(p);
      }
      p.fids.push(f.pos);
    }

    if (phases.length > 0) {
      // Find phase with the most fiducials for robust row/col counting
      phases.sort((a, b) => b.fids.length - a.fids.length);
      const bestPhase = phases[0];
      const xs = bestPhase.fids.map(f => f.x);
      const ys = bestPhase.fids.map(f => f.y);
      cols = Math.max(1, Math.round((Math.max(...xs) - Math.min(...xs)) / stepX) + 1);
      rows = Math.max(1, Math.round((Math.max(...ys) - Math.min(...ys)) / stepY) + 1);
    }
  } else if (stepX > 5) {
    cols = Math.max(1, Math.round((Math.max(...valid.map(f => f.pos.x)) - minX) / stepX) + 1);
  } else if (stepY > 5) {
    rows = Math.max(1, Math.round((Math.max(...valid.map(f => f.pos.y)) - minY) / stepY) + 1);
  }

  if (rows <= 1 && cols <= 1) return null;
  return { rows, cols, stepX, stepY };
}

export function nearestNeighborSort(components, startX = 0, startY = 0) {
  if (components.length <= 1) return [...components];
  const remaining = [...components], sorted = [];
  let cx = startX, cy = startY;
  while (remaining.length) {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const dist = Math.hypot(remaining[i].x - cx, remaining[i].y - cy);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    const comp = remaining.splice(bestIdx, 1)[0];
    sorted.push(comp); cx = comp.x; cy = comp.y;
  }
  return sorted;
}

export function totalTravelMm(components, startX = 0, startY = 0) {
  if (!components.length) return 0;
  let dist = Math.hypot(components[0].x - startX, components[0].y - startY);
  for (let i = 1; i < components.length; i++) dist += Math.hypot(components[i].x - components[i - 1].x, components[i].y - components[i - 1].y);
  return dist;
}

export function Sparkline({ values, color = '#58a6ff', height = 36, width = '100%' }) {
  if (!values || values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
  const W = 260, H = height;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * W).toFixed(1)},${(H - ((v - min) / range) * (H - 4) - 2).toFixed(1)}`).join(' ');
  const last = values[values.length - 1], lx = W, ly = H - ((last - min) / range) * (H - 4) - 2;
  return <svg viewBox={`0 0 ${W} ${H}`} style={{ width, height, display: 'block', overflow: 'visible' }}><polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" /><circle cx={lx} cy={ly} r="3" fill={color} /></svg>;
}
