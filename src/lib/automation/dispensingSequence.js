import { applyTransform } from '../utils/transform2d.js';
import { getComponentBoundaryOffsets, calculatePerimeterLength } from '../../components/dispensingHelpers.jsx';

export class DispensingSequencer {
  constructor() {
    this.safeHeight = 5; // mm above PCB
    this.travelSpeed = 300; // mm/min — safe feed (≤ GRBL $111) to avoid lost steps / jerk
    this.dispensingSpeed = 250; // mm/min — safe outline trace (≤ GRBL Y max)
  }

  calculateOptimalSequence(referencePoint, pads, config = {}) {
    if (!pads || pads.length === 0) return [];

    let expandedPads = [];
    const { enableMultiDot = true, nozzleDia = 0.8 } = config;

    if (enableMultiDot) {
      pads.forEach(pad => {
        expandedPads.push(...this.generateSubDots(pad, nozzleDia));
      });
    } else {
      expandedPads = [...pads];
    }

    // Clone pads to avoid mutating original array
    const unvisited = [...expandedPads];
    const sequence = [];
    let currentPoint = referencePoint;

    // Nearest Neighbor Greedy Algorithm
    while (unvisited.length > 0) {
      let nearestIdx = -1;
      let minDistance = Infinity;

      for (let i = 0; i < unvisited.length; i++) {
        const dist = this.calculateDistance(currentPoint, unvisited[i]);
        if (dist < minDistance) {
          minDistance = dist;
          nearestIdx = i;
        }
      }

      if (nearestIdx !== -1) {
        const nearestPad = unvisited[nearestIdx];

        sequence.push({
          ...nearestPad,
          distanceFromPrevious: minDistance,
          sequenceOrder: sequence.length + 1
        });

        currentPoint = nearestPad;
        unvisited.splice(nearestIdx, 1);
      } else {
        break; // Should not happen
      }
    }

    // --- 2-Opt TSP Optimization (removes crossing paths) ---
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < sequence.length - 1; i++) {
        for (let k = i + 1; k < sequence.length; k++) {
          let distBefore = this.calculateDistance(i === 0 ? referencePoint : sequence[i - 1], sequence[i]);
          let distAfter = this.calculateDistance(i === 0 ? referencePoint : sequence[i - 1], sequence[k]);

          if (k < sequence.length - 1) {
            distBefore += this.calculateDistance(sequence[k], sequence[k + 1]);
            distAfter += this.calculateDistance(sequence[i], sequence[k + 1]);
          }

          // If swapping these edges reduces the total distance by more than float dust
          if (distAfter < distBefore - 0.001) {
            const reversed = sequence.slice(i, k + 1).reverse();
            sequence.splice(i, k - i + 1, ...reversed);
            improved = true;
          }
        }
      }
    }

    // Recalculate properties after 2-opt reordering
    sequence.forEach((pad, index) => {
      pad.sequenceOrder = index + 1;
      pad.distanceFromPrevious = this.calculateDistance(
        index === 0 ? referencePoint : sequence[index - 1],
        pad
      );
    });

    return sequence;
  }

  /**
   * Automatically generate multiple dispensing dots for pads larger than the nozzle
   */
  generateSubDots(pad, nozzleDia) {
    if (!pad || !pad.width || !pad.height || !nozzleDia) return [pad];

    // Standard pitch: step every 1.2x nozzle diameter for good overlap
    const pitch = nozzleDia * 1.2;

    // Safe inner core: We strictly restrict multi-dot dispensing to the central 40% 
    // of the component footprint to avoid dispensing glue onto the copper pads.
    const safeWidth = (pad.width || 1) * 0.4;
    const safeHeight = (pad.height || 1) * 0.4;

    const needsSplitX = safeWidth > nozzleDia * 1.8;
    const needsSplitY = safeHeight > nozzleDia * 1.8;

    if (!needsSplitX && !needsSplitY) {
      return [pad];
    }

    const subDots = [];
    const countX = needsSplitX ? Math.max(2, Math.floor(safeWidth / pitch)) : 1;
    const countY = needsSplitY ? Math.max(2, Math.floor(safeHeight / pitch)) : 1;

    // Calculate actual span and center it within the pad
    const spanX = (countX - 1) * pitch;
    const spanY = (countY - 1) * pitch;

    const startX = pad.x - (spanX / 2);
    const startY = pad.y - (spanY / 2);

    for (let i = 0; i < countX; i++) {
      for (let j = 0; j < countY; j++) {
        subDots.push({
          ...pad,
          x: startX + (i * pitch),
          y: startY + (j * pitch),
          isSubDot: true,
          width: pitch, // shrink pressure footprint for subdots
          height: pitch,
          _originalArea: pad.width * pad.height
        });
      }
    }
    return subDots;
  }

  /**
   * Generate complete G-code for automated dispensing sequence
   * @param {Object} referencePoint - Starting point
   * @param {Array} pads - Ordered pad sequence
   * @param {Object} settings - Dispensing settings
   * @returns {String} Complete G-code for dispensing job
   */
  generateDispensingGCode(referencePoint, pads, settings = {}) {
    const {
      safeHeight = this.safeHeight,
      travelSpeed = this.travelSpeed,
      dispensingSpeed = this.dispensingSpeed,
      pressureSettings = {},
      xf,
      applyXf,
      toolOffset = { dx: 0, dy: 0 },
      valveOnCmd = 'M3 S255 M8', // Standard GRBL Spindle ON + Coolant ON
      valveOffCmd = 'M5 M9',     // Standard GRBL Spindle OFF + Coolant OFF
      dispenseHeight = 0.5,     // mm above board to dispense
      side = 'top',             // current board side
      boardWidth = 0            // for mirroring
    } = settings;

    // Helper to transform coordinates and APPLY PHYSICAL NOZZLE OFFSET
    const transform = (pt) => {
      let mapped = { ...pt };

      if (applyXf && xf) {
        mapped = applyTransform(xf, mapped);
      }
      // The nozzle is physically offset from the camera's assumed position.
      // posA = needle position on dot, posB = camera position on dot.
      // toolOffset.dx = posA.x - posB.x.
      // To shift the gantry from camera coordinate to needle position:
      // MachinePos = Target + toolOffset
      return {
        ...mapped,
        x: mapped.x + (toolOffset?.dx || 0),
        y: mapped.y + (toolOffset?.dy || 0)
      };
    };

    transform(referencePoint); // Validate reference point can be transformed

    let gcode = [];

    // Header and initialization
    gcode.push('; --- Automated Glue Dispensing Job ---');
    gcode.push(`; Total pads: ${pads.length}`);
    gcode.push(`; Tool Offset Applied -> DX: ${toolOffset.dx.toFixed(2)}, DY: ${toolOffset.dy.toFixed(2)}`);
    gcode.push('');
    gcode.push('G21 ; Set units to millimeters');
    gcode.push('G90 ; Absolute positioning');
    gcode.push('$H ; Home all axes (GRBL)');
    gcode.push(`G1 Z${safeHeight} F${travelSpeed} ; Lift to safe travel height`);
    gcode.push('');

    // Dispense along the outer boundary / outline of each component in sequence
    pads.forEach((pad, index) => {
      const boundaryOffsets = getComponentBoundaryOffsets(pad);
      const boundaryVertices = boundaryOffsets.map(bo => transform({ x: pad.x + bo.dx, y: pad.y + bo.dy }));
      const v0 = boundaryVertices[0];

      gcode.push(`; --- Component ${index + 1}/${pads.length}: ${pad.id || `C${index + 1}`} (Outer Boundary Outline) ---`);

      // Travel to first boundary vertex (safe height)
      gcode.push(`G1 X${v0.x.toFixed(3)} Y${v0.y.toFixed(3)} Z${safeHeight} F${travelSpeed}`);

      // Lower to dispensing height
      gcode.push(`G1 Z${dispenseHeight} F${dispensingSpeed} ; Lower nozzle to dispense`);

      // Valve ON — begin tracing outer boundary outline
      gcode.push(`${valveOnCmd} ; Valve ON (Begin boundary trace)`);

      for (let vi = 1; vi < boundaryVertices.length; vi++) {
        const v = boundaryVertices[vi];
        gcode.push(`G1 X${v.x.toFixed(3)} Y${v.y.toFixed(3)} F${dispensingSpeed}`);
      }

      // Ensure closed perimeter back to start point
      const lastV = boundaryVertices[boundaryVertices.length - 1];
      if (Math.hypot(lastV.x - v0.x, lastV.y - v0.y) > 0.005) {
        gcode.push(`G1 X${v0.x.toFixed(3)} Y${v0.y.toFixed(3)} F${dispensingSpeed}`);
      }

      // Valve OFF
      gcode.push(`${valveOffCmd} ; Valve OFF (Boundary trace complete)`);

      // Lift to safe height
      gcode.push(`G1 Z${safeHeight} F${travelSpeed} ; Retract to safe height`);
      gcode.push('');
    });

    // Return to home completely
    gcode.push('; --- Job Finished ---');
    gcode.push(`G1 X0 Y0 F${travelSpeed} ; Return home`);
    gcode.push('M84 ; Disable steppers');


    return gcode.join('\n');
  }

  /**
   * Calculate distance between two points
   */
  calculateDistance(point1, point2) {
    const dx = point2.x - point1.x;
    const dy = point2.y - point1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Calculate total dispensing job statistics
   */
  calculateJobStatistics(referencePoint, sequence) {
    let totalDistance = 0;
    let totalTime = 0; // seconds
    let currentPoint = referencePoint;

    sequence.forEach(pad => {
      const travelDist = this.calculateDistance(currentPoint, pad);
      const boundaryOffsets = getComponentBoundaryOffsets(pad);
      const perimeter = calculatePerimeterLength(boundaryOffsets);

      totalDistance += travelDist + perimeter;

      // Travel time between components + boundary tracing time + Z clearance overhead
      const travelTime = (travelDist / this.travelSpeed) * 60; // convert to seconds
      const perimeterTime = (perimeter / this.dispensingSpeed) * 60;
      const zOverhead = 0.5; // plunge and retract time
      totalTime += travelTime + perimeterTime + zOverhead;

      currentPoint = pad;
    });

    return {
      totalPads: sequence.length,
      totalDistance: totalDistance.toFixed(2),
      estimatedTime: Math.ceil(totalTime / 60), // minutes
      averageDistance: (totalDistance / sequence.length).toFixed(2)
    };
  }

  /**
   * Mathematically calculate exact surface area depending on Gerber pad shape
   */
  calculatePadArea(pad) {
    if (pad.isSubDot) {
      // Generate sub-dots use a standard bounding box calculation based on their reduced pitch
      return (pad.width || 1) * (pad.height || 1);
    }
    
    const w = pad.width || 0;
    const h = pad.height || 0;
    const shape = (pad.shape || '').toLowerCase();

    if (shape === 'circle' && w > 0) {
      const r = w / 2;
      return Math.PI * r * r;
    } else if (shape === 'rect' || shape === 'square' || shape === 'rectangle') {
      return w * h;
    } else if (shape === 'obround' || shape === 'oval') {
      const r = Math.min(w, h) / 2;
      const rectLength = Math.max(w, h) - (2 * r);
      return (rectLength * (2 * r)) + (Math.PI * r * r);
    } else {
      // SMT generic fallback bounding box
      return (w || 1) * (h || 1);
    }
  }

  /**
   * Calculate pressure for specific pad based on geometric area
   */
  calculatePadPressure(pad, pressureSettings) {
    const area = this.calculatePadArea(pad);
    const basePressure = pressureSettings.customPressure || 25;

    // Adjust pressure based on mathematically precise pad area
    if (area < 0.5) return Math.max(15, basePressure - 5);
    if (area > 2.0) return Math.min(40, basePressure + 5);
    return basePressure;
  }

  /**
   * Option A: Scale Dwell Time Mathematically Proportional to Pad Surface Area
   */
  calculateDwellTime(pad, pressureSettings) {
    const area = this.calculatePadArea(pad);
    const baseDwell = pressureSettings.customDwellTime || 120;

    // Assume the UI "Base Dwell Time" targets a standardized 1.0 mm² pad size reference.
    const referenceAreaSqMm = 1.0;

    // Precise linear mathematical scaling based on physical area
    let calculatedDwell = baseDwell * (area / referenceAreaSqMm);

    // Provide sensible physical bounds to prevent machine stutters or ridiculous giant glue puddles
    calculatedDwell = Math.max(20, calculatedDwell);       // absolute minimum 20ms valve fire time
    calculatedDwell = Math.min(baseDwell * 5, calculatedDwell); // maximum 5x the base time

    return Math.round(calculatedDwell);
  }

  /**
   * Determine dispensing mode for component: always uses outer boundary outline tracing.
   *
   * @param {Object} pad
   * @returns {{ mode: 'outline', perimeter: number, length: number }}
   */
  selectDispenseMode(pad) {
    const boundaryOffsets = getComponentBoundaryOffsets(pad);
    const perimeter = calculatePerimeterLength(boundaryOffsets);
    return { mode: 'outline', perimeter, length: perimeter };
  }
}