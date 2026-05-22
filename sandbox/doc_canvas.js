/**
 * BIM OOTB — Frictionless BIM. Two DBs. One browser. Zero install.
 * Copyright (c) 2025-2026 Redhuan D. Oon <red1org@gmail.com>
 * SPDX-License-Identifier: MIT
 */
// doc_canvas.js — Doc pill canvas: envelope wireframe, fresh 2D grid, Gantt stepper
// Implementing NEW_FROM_REFERENCE.md §4, §7 — Witness: W-DOC-CANVAS
//
// This is a NEW grid, not the existing grid_overlay. Clean start, no legacy baggage.
// The grid aligns to the BOM envelope AABB and shows dimension labels.

(function(window) {
'use strict';

var _group = null;       // Three.js group holding all Doc canvas objects
var _gridGroup = null;   // sub-group for grid lines + labels
var _envGroup = null;    // sub-group for envelope wireframe
var _phaseGroup = null;  // sub-group for Gantt phase elements
var _active = false;
var _gridOn = false;
var _phaseIndex = -1;    // -1 = step zero (envelope only)
var _phases = [];        // Gantt phases [{name, disc, guids}]
var _hiddenMeshes = [];  // stash of meshes hidden when Doc activates
var _batchedState = [];  // [{mesh, meta}] — BatchedMesh objects with per-slot visibility
var _instancedState = []; // [{mesh, meta}] — InstancedMesh objects with per-instance visibility
var _guidToSlot = {};    // guid → {mesh, slotId} — fast lookup for BatchedMesh materialize
var _guidToInstance = {}; // guid → {mesh, index, origMatrix} — fast lookup for InstancedMesh
var _activeDisc = 'ARC'; // active discipline for Next — default ARC
var _shownCount = 0;     // running count of elements revealed by Next

// ── IFC class → grid strategy table (data, not code) ────────────────────────
// Each entry: { axes: 'XZ'|'long'|'none', desc: string }
//   'XZ'   = add grid lines on both X and Z axes (intersection marker)
//   'long' = add grid line perpendicular to wall's long axis (centerline)
//   'none' = no grid lines
var GRID_STRATEGY = {
  IfcColumn:             { axes: 'XZ',   desc: 'column → both axes' },
  IfcPile:               { axes: 'XZ',   desc: 'pile → both axes' },
  IfcWall:               { axes: 'long', desc: 'wall → perpendicular to long axis' },
  IfcWallStandardCase:   { axes: 'long', desc: 'wall → perpendicular to long axis' },
  // Explicitly no grid lines:
  IfcSlab:               { axes: 'none', desc: 'slab → no grid lines' },
  IfcBeam:               { axes: 'none', desc: 'beam → no grid lines (per user Q6)' },
  IfcDoor:               { axes: 'long', desc: 'door → opening grid line (child of wall)' },
  IfcWindow:             { axes: 'long', desc: 'window → opening grid line (child of wall)' },
  IfcOpening:            { axes: 'long', desc: 'opening → child of wall' },
  IfcOpeningElement:     { axes: 'long', desc: 'opening → child of wall' },
  IfcStair:              { axes: 'none', desc: 'stair → no grid' },
  IfcStairFlight:        { axes: 'none', desc: 'stairflight → no grid' },
  IfcRailing:            { axes: 'none', desc: 'railing → no grid' },
  IfcCurtainWall:        { axes: 'none', desc: 'curtain wall → no grid (facade)' },
  IfcRoof:               { axes: 'none', desc: 'roof → no grid' },
  IfcCovering:           { axes: 'none', desc: 'covering/tile → no grid' },
  IfcFooting:            { axes: 'XZ',   desc: 'footing → both axes (foundation grid)' },
  IfcPlate:              { axes: 'none', desc: 'plate → no grid' },
  IfcMember:             { axes: 'none', desc: 'member → no grid (secondary structure)' },
  // MEP classes → never grid
  IfcFlowSegment:        { axes: 'none', desc: 'pipe/duct → no grid' },
  IfcFlowTerminal:       { axes: 'none', desc: 'terminal → no grid' },
  IfcFlowFitting:        { axes: 'none', desc: 'fitting → no grid' },
  IfcDistributionElement:{ axes: 'none', desc: 'distribution → no grid' }
};

// ── Coordinate transform: IFC → Three.js (single source of truth) ──────────
function _ifcToThree(ifcX, ifcY, ifcZ, offset) {
  var ox = offset ? offset.x : 0;
  var oy = offset ? offset.y : 0;
  var oz = offset ? offset.z : 0;
  return {
    x: ifcX - ox,            // IFC X → Three X
    y: (ifcZ || 0) - oz,     // IFC Z → Three Y (up)
    z: -(ifcY - oy)          // IFC Y → Three -Z (into screen)
  };
}

/**
 * activate(A) — enter Doc canvas mode
 * Hides all building meshes, shows envelope + grid
 */
function activate(A) {
  if (_active) return;
  if (!A || !A.scene || !A._bom) {
    console.warn('§DOC_CANVAS no scene or BOM');
    return;
  }
  _active = true;

  // Create root group
  _group = new THREE.Group();
  _group.name = 'DocCanvas';
  A.scene.add(_group);

  _envGroup = new THREE.Group();
  _envGroup.name = 'DocEnvelope';
  _group.add(_envGroup);

  _gridGroup = new THREE.Group();
  _gridGroup.name = 'DocGrid';
  _group.add(_gridGroup);

  _phaseGroup = new THREE.Group();
  _phaseGroup.name = 'DocPhases';
  _group.add(_phaseGroup);

  // Hide all existing building meshes
  // §S260 BatchedMesh: hide per-slot, not per-mesh, so nextPhase can reveal individually
  _hiddenMeshes = [];
  _batchedState = [];
  _instancedState = [];
  _guidToSlot = {};
  _guidToInstance = {};
  var _zeroMatrix = new THREE.Matrix4();
  if (_zeroMatrix.makeScale) _zeroMatrix.makeScale(0, 0, 0);
  A.scene.traverse(function(obj) {
    if (obj === _group || obj.parent === _group ||
        obj.parent === _envGroup || obj.parent === _gridGroup ||
        obj.parent === _phaseGroup) return;
    // §S260: BatchedMesh — hide all slots, build guid→slot lookup
    if (obj.isBatchedMesh && A._batchMeta && A._batchMeta[obj.id]) {
      var meta = A._batchMeta[obj.id];
      for (var si = 0; si < meta.length; si++) {
        obj.setVisibleAt(meta[si].slotId, false);
        _guidToSlot[meta[si].guid] = { mesh: obj, slotId: meta[si].slotId };
      }
      _batchedState.push({ mesh: obj, meta: meta });
      return;
    }
    // InstancedMesh — hide all instances via zero-scale, build guid→instance lookup
    if (obj.isInstancedMesh && A._instanceMeta && A._instanceMeta[obj.id]) {
      var imeta = A._instanceMeta[obj.id];
      for (var ii = 0; ii < imeta.length; ii++) {
        // Save original matrix before zeroing
        if (!imeta[ii]._origMatrix) {
          imeta[ii]._origMatrix = new THREE.Matrix4();
          obj.getMatrixAt(ii, imeta[ii]._origMatrix);
        }
        obj.setMatrixAt(ii, _zeroMatrix);
        _guidToInstance[imeta[ii].guid] = { mesh: obj, index: ii, origMatrix: imeta[ii]._origMatrix };
      }
      obj.instanceMatrix.needsUpdate = true;
      _instancedState.push({ mesh: obj, meta: imeta });
      return;
    }
    if (obj.isMesh && obj.visible) {
      obj.visible = false;
      _hiddenMeshes.push(obj);
    }
  });

  // Build envelope wireframe
  _buildEnvelope(A);

  // Build grid (auto-ON)
  _gridOn = true;
  _buildGrid(A);

  // §S267: Snapshot grid originals for delta computation
  _snapshotGridOriginals();

  // Reset phase stepper
  _phaseIndex = -1;
  _shownCount = 0;
  _loadPhases(A);

  // Position camera to see envelope
  _fitCamera(A);

  // Wire grid interaction (select-then-drag)
  _initInteraction(A);

  // Update HUD for Doc mode — step zero, 0 elements
  _updateHud();

  // Show timeline slider
  _showTimeline(A);
  _updateTimeline();

  console.log('§DOC_CANVAS activate building=' + A._bom.building +
    ' hidden=' + _hiddenMeshes.length +
    ' batched=' + Object.keys(_guidToSlot).length +
    ' instanced=' + Object.keys(_guidToInstance).length +
    ' envelope=' + A._bom.envelope.width + 'x' + A._bom.envelope.depth + 'x' + A._bom.envelope.height + 'm');
}

/**
 * deactivate(A) — exit Doc canvas, restore building meshes
 */
function deactivate(A) {
  if (!_active) return;
  _active = false;

  // Restore hidden meshes
  for (var i = 0; i < _hiddenMeshes.length; i++) {
    _hiddenMeshes[i].visible = true;
  }
  _hiddenMeshes = [];

  // §S260: Restore BatchedMesh slots to visible
  for (var bi = 0; bi < _batchedState.length; bi++) {
    var bs = _batchedState[bi];
    for (var si = 0; si < bs.meta.length; si++) {
      bs.mesh.setVisibleAt(bs.meta[si].slotId, true);
    }
  }
  _batchedState = [];
  _guidToSlot = {};

  // Restore InstancedMesh instances to original matrices
  for (var ii = 0; ii < _instancedState.length; ii++) {
    var is_ = _instancedState[ii];
    for (var ij = 0; ij < is_.meta.length; ij++) {
      if (is_.meta[ij]._origMatrix) {
        is_.mesh.setMatrixAt(ij, is_.meta[ij]._origMatrix);
      }
    }
    is_.mesh.instanceMatrix.needsUpdate = true;
    is_.mesh.visible = true;
  }
  _instancedState = [];
  _guidToInstance = {};

  // Hide Doc HUD sections + timeline
  _hideHud();
  _hideTimeline();
  _shownCount = 0;

  // Remove Doc group from scene
  if (_group && A.scene) {
    A.scene.remove(_group);
    _disposeGroup(_group);
  }
  _group = _envGroup = _gridGroup = _phaseGroup = null;
  _phaseIndex = -1;
  _phases = [];

  console.log('§DOC_CANVAS deactivate');
}

/**
 * toggleGrid() — show/hide the 2D grid
 */
function toggleGrid() {
  _gridOn = !_gridOn;
  if (_gridGroup) _gridGroup.visible = _gridOn;
  console.log('§DOC_GRID on=' + _gridOn);
  return _gridOn;
}

/**
 * nextPhase(A) — advance one construction phase for the active discipline.
 * §6.4: As elements appear, grid lines are auto-added at their positions.
 * Only ARC discipline triggers grid line creation (walls define structure).
 * STR columns also create grid lines. MEP/FP/ELEC do not.
 */
function nextPhase(A) {
  if (!_active || !A) return;

  // Filter phases by active discipline (default ARC)
  var filtered = _phases.filter(function(p) {
    return !_activeDisc || p.disc === _activeDisc;
  });

  _phaseIndex++;
  if (_phaseIndex >= filtered.length) {
    console.log('§DOC_NEXT all ' + (_activeDisc || 'ALL') + ' phases shown (' + filtered.length + ')');
    _phaseIndex = filtered.length - 1;
    return;
  }
  var phase = filtered[_phaseIndex];
  _materializePhase(A, phase);

  // §17.9B: No auto-grid. User taps wall/element → grid line appears.
  // Auto-grid removed: was flooding canvas with 200+ lines from hospital walls.
  // _autoGridFromPhase(A, phase) — disabled, kept for reference
  // Grid lines added only via user click (handleElementPick) or Rosetta drag.

  // Update HUD with new grid bays + element count + timeline
  _updateHud();
  _updateTimeline();

  console.log('§DOC_NEXT phase=' + (_phaseIndex + 1) + '/' + filtered.length +
    ' disc=' + (phase.disc || '?') + ' name=' + phase.name +
    ' elements=' + phase.guids.length + ' gridMode=user-pick');
}

/**
 * _autoGridFromPhase(A, phase) — extract grid-worthy positions from phase elements.
 * Walls: add X/Z lines at wall centerlines (long axis determines which).
 * Columns: add X and Z lines at column positions.
 * Openings, MEP: no grid lines.
 */
function _autoGridFromPhase(A, phase) {
  if (!A.db || !A._docEnv || !phase.guids.length) return 0;

  // Query in batches of 200 to avoid SQL length limits
  var allRows = [];
  for (var batch = 0; batch < phase.guids.length; batch += 200) {
    var chunk = phase.guids.slice(batch, batch + 200);
    var quotedGuids = chunk.map(function(g) {
      return "'" + g.replace(/'/g, "''") + "'";
    }).join(',');
    var rows = A.dbQuery(
      'SELECT m.ifc_class, t.center_x, t.center_y, t.bbox_x, t.bbox_y ' +
      'FROM elements_meta m JOIN element_transforms t ON m.guid = t.guid ' +
      'WHERE m.guid IN (' + quotedGuids + ')'
    );
    allRows = allRows.concat(rows);
  }

  var added = 0;
  for (var i = 0; i < allRows.length; i++) {
    var cls = allRows[i][0];
    var strategy = GRID_STRATEGY[cls];

    // Unknown class → default 'none' (extract, not invent)
    if (!strategy || strategy.axes === 'none') continue;

    var pt = _ifcToThree(allRows[i][1], allRows[i][2], 0, A.modelOffset);
    var bx = allRows[i][3] || 0;
    var by = allRows[i][4] || 0;

    // Wall length filter: only walls >4m contribute grid lines.
    // Short partition walls are room dividers, not structural bays.
    var isWall = cls === 'IfcWall' || cls === 'IfcWallStandardCase';
    if (isWall) {
      var wallLen = Math.max(bx, by) * 2;  // half-extent → full length
      if (wallLen < 4.0) continue;
    }

    if (strategy.axes === 'XZ') {
      // Grid intersection — add both axes
      if (_addGridPosition('X', pt.x)) added++;
      if (_addGridPosition('Z', pt.z)) added++;
    } else if (strategy.axes === 'long') {
      // Wall/opening centerline — perpendicular to long axis
      if (bx > by * 1.5) {
        // runs along IFC X → grid line at Z position (depth)
        if (_addGridPosition('Z', pt.z)) added++;
      } else if (by > bx * 1.5) {
        // runs along IFC Y → grid line at X position (width)
        if (_addGridPosition('X', pt.x)) added++;
      } else {
        // roughly square → both axes
        if (_addGridPosition('X', pt.x)) added++;
        if (_addGridPosition('Z', pt.z)) added++;
      }
    }

    // Log kernel_op for each auto-detected grid line
    if (added > 0 && window.KernelOps && A.db) {
      try {
        KernelOps.commitOp(A.db, 'GRID_ADD', JSON.stringify({
          source: 'auto', phase: phase.name, cls: cls,
          axis: strategy.axes, x: pt.x, z: pt.z
        }), null, null);
      } catch(e) { /* kernel_ops optional */ }
    }
  }

  if (added) _resortLabels();
  return added;
}

function _resortLabels() {
  // Re-sort X positions and regenerate labels (A, B, C...)
  var xPairs = _xPositions.map(function(p, i) { return { pos: p, lbl: _xLabels[i] }; });
  xPairs.sort(function(a, b) { return a.pos - b.pos; });
  _xPositions = xPairs.map(function(p) { return p.pos; });
  // Regenerate clean labels
  var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  _xLabels = _xPositions.map(function(_, i) {
    return i < 26 ? letters[i] : letters[Math.floor(i / 26) - 1] + letters[i % 26];
  });

  // Re-sort Z positions and regenerate labels (1, 2, 3...)
  var zPairs = _zPositions.map(function(p, i) { return { pos: p, lbl: _zLabels[i] }; });
  zPairs.sort(function(a, b) { return a.pos - b.pos; });
  _zPositions = zPairs.map(function(p) { return p.pos; });
  _zLabels = _zPositions.map(function(_, i) { return String(i + 1); });
}

// ── Envelope wireframe ──────────────────────────────────────────────────────
function _buildEnvelope(A) {
  // §S267: Envelope from BOM root AABB when BOM.db available (recipe, not scatter)
  var env;
  // §S267: try BOM data from A._bomDb (standalone) or A.db (merged extracted)
  var _envBomDb = A._bomDb || A.db;
  if (_envBomDb && window.BOMWalker) {
    // Guard: check if m_bom table exists before querying
    try { var boms = BOMWalker.listBoms(_envBomDb); } catch(e) { boms = []; }
    var building = null;
    for (var bi = 0; bi < boms.length; bi++) {
      if (boms[bi].bomType === 'BUILDING') { building = boms[bi]; break; }
    }
    if (building) {
      var rootRows = BOMWalker._query(_envBomDb,
        "SELECT origin_x, origin_y, origin_z, aabb_width_mm, aabb_depth_mm, aabb_height_mm " +
        "FROM m_bom WHERE bom_id = '" + building.bomId.replace(/'/g, "''") + "'");
      if (rootRows.length) {
        var r = rootRows[0];
        var ox = r[0], oy = r[1], oz = r[2];
        var wm = r[3] / 1000, dm = r[4] / 1000, hm = r[5] / 1000;
        env = { minX: ox, maxX: ox + wm, minY: oy, maxY: oy + dm, minZ: oz, maxZ: oz + hm };
        console.log('§DOC_ENVELOPE source=BOM root=' + building.bomId +
          ' aabb=' + wm.toFixed(1) + 'x' + dm.toFixed(1) + 'x' + hm.toFixed(1) + 'm' +
          ' origin=(' + ox.toFixed(1) + ',' + oy.toFixed(1) + ',' + oz.toFixed(1) + ')');
      }
    }
  }

  // Fallback to bom_extract envelope (IFC Drop path — no BOM.db)
  if (!env && A._bom && A._bom.envelope) {
    env = A._bom.envelope;
    console.log('§DOC_ENVELOPE source=bom_extract (no BOM.db)');
  }

  if (!env) {
    console.warn('§DOC_ENVELOPE no envelope data');
    return;
  }

  var lo = _ifcToThree(env.minX, env.maxY, env.minZ, A.modelOffset); // IFC min corner
  var hi = _ifcToThree(env.maxX, env.minY, env.maxZ, A.modelOffset); // IFC max corner

  var x0 = lo.x, x1 = hi.x;
  var y0 = lo.y, y1 = hi.y;  // Three Y (up) from IFC Z
  var z0 = lo.z, z1 = hi.z;  // Three -Z from IFC Y (note: lo.z > hi.z due to negation)

  var w = x1 - x0, h = y1 - y0, d = z1 - z0;
  var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;

  // Wireframe box
  var geo = new THREE.BoxGeometry(w, h, d);
  var edges = new THREE.EdgesGeometry(geo);
  var mat = new THREE.LineBasicMaterial({ color: 0xff4444, linewidth: 2, transparent: true, opacity: 0.6 });
  var wireframe = new THREE.LineSegments(edges, mat);
  wireframe.position.set(cx, cy, cz);
  _envGroup.add(wireframe);

  // Store envelope bounds for grid
  A._docEnv = { x0: x0, x1: x1, y0: y0, y1: y1, z0: z0, z1: z1, w: w, h: h, d: d,
    ox: env.minX, oy: env.minY, oz: env.minZ };

  geo.dispose();
}

// ── Fresh 2D Grid — AABBCC bubbles + span dimensions ────────────────────────
// Implementing NEW_FROM_REFERENCE.md §6.4 — grid follows BOM hierarchy, top-down.
// Step zero (envelope): 2 X-lines (A,B), 2 Z-lines (1,2), 4 bubbles, 2 span dims.
// Grid refines ONLY as Next reveals elements. Extract, not invent.
var _xPositions = [];   // current committed X grid line positions (Three.js coords)
var _zPositions = [];   // current committed Z grid line positions (Three.js coords)
var _xLabels = [];      // labels for X lines (A, B, C...)
var _zLabels = [];      // labels for Z lines (1, 2, 3...)
var _extend = 8;        // grid lines extend beyond envelope (fixed, not relative)
var _rosettaExtend = 14; // Rosetta template lines pulled further out for clarity
var _lineColor = 0xff4444;
var _dimColor = '#4fc3f7';
var _bubbleColor = '#ff8888';

function _buildGrid(A) {
  if (!A._docEnv) return;
  var e = A._docEnv;

  // §6.4 Step zero — BUILDING level: envelope AABB only
  // 2 X-lines at envelope minX, maxX. 2 Z-lines at envelope minZ, maxZ.
  // No cadence, no subdivision, no internal structure. Nothing is invented.
  _xPositions = [e.x0, e.x1];
  _xLabels = ['A', 'B'];
  _zPositions = [e.z0, e.z1];
  _zLabels = ['1', '2'];

  _renderGrid(A);

  console.log('§DOC_GRID step_zero xLines=2 zLines=2' +
    ' width=' + e.w.toFixed(2) + 'm depth=' + e.d.toFixed(2) + 'm');
}

/**
 * _renderGrid(A) — clears and redraws all grid lines, bubbles, dimensions
 * from current _xPositions/_zPositions arrays. Called after _buildGrid or
 * after nextPhase adds new lines.
 */
function _renderGrid(A) {
  if (!A._docEnv || !_gridGroup) return;
  var e = A._docEnv;

  // Clear existing grid objects
  while (_gridGroup.children.length) {
    var child = _gridGroup.children[0];
    _gridGroup.remove(child);
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (child.material.map) child.material.map.dispose();
      child.material.dispose();
    }
  }

  // ── Draw X grid lines (lettered) with bubbles at both ends ──
  for (var a = 0; a < _xPositions.length; a++) {
    var xp = _xPositions[a];
    var lbl = _xLabels[a] || String.fromCharCode(65 + a);
    _addGridLine(xp, e.y0, e.z0 - _extend, xp, e.y0, e.z1 + _extend, _lineColor, 'X', a);
    _addBubble(lbl, xp, e.y0, e.z0 - _extend - 5, _bubbleColor, 'X', a, 'start');
    _addBubble(lbl, xp, e.y0, e.z1 + _extend + 5, _bubbleColor, 'X', a, 'end');
  }

  // ── Draw Z grid lines (numbered) with bubbles at both ends ──
  for (var b = 0; b < _zPositions.length; b++) {
    var zp = _zPositions[b];
    var zlbl = _zLabels[b] || String(b + 1);
    _addGridLine(e.x0 - _extend, e.y0, zp, e.x1 + _extend, e.y0, zp, _lineColor, 'Z', b);
    _addBubble(zlbl, e.x0 - _extend - 5, e.y0, zp, _bubbleColor, 'Z', b, 'start');
    _addBubble(zlbl, e.x1 + _extend + 5, e.y0, zp, _bubbleColor, 'Z', b, 'end');
  }

  // ── Span dimensions between X lines ──
  for (var sx = 1; sx < _xPositions.length; sx++) {
    var span = Math.abs(_xPositions[sx] - _xPositions[sx - 1]);
    var midX = (_xPositions[sx] + _xPositions[sx - 1]) / 2;
    _addDimLabel(span.toFixed(2) + 'm', midX, e.y0, e.z0 - _extend - 2, _dimColor);
  }

  // ── Span dimensions between Z lines ──
  for (var sz = 1; sz < _zPositions.length; sz++) {
    var spanZ = Math.abs(_zPositions[sz] - _zPositions[sz - 1]);
    var midZ = (_zPositions[sz] + _zPositions[sz - 1]) / 2;
    _addDimLabel(spanZ.toFixed(2) + 'm', e.x0 - _extend - 2, e.y0, midZ, _dimColor);
  }

  // ── Height label on vertical ──
  _addDimLabel(A._bom.envelope.height.toFixed(1) + 'm', e.x0 - 4, (e.y0 + e.y1) / 2, e.z0 - 4, _dimColor);

  // Also render Rosetta template lines (grey/gold depending on mode)
  _renderRosettaTemplates(A);
}

/**
 * addGridLine(axis, position, label) — add a new grid line at runtime
 * Called by nextPhase when elements justify a new line.
 * Returns true if line was added, false if position is too close to existing.
 */
function _addGridPosition(axis, position, label) {
  var arr = axis === 'X' ? _xPositions : _zPositions;
  var labels = axis === 'X' ? _xLabels : _zLabels;

  // Skip if too close to an existing line.
  // 2m dedup for auto-grid (walls/columns within 2m merge to same grid line).
  // 0.3m dedup for Rosetta manual placement (user controls fine positioning).
  var minGap = _calibrationMode ? 0.3 : 2.0;
  for (var i = 0; i < arr.length; i++) {
    if (Math.abs(arr[i] - position) < minGap) return false;
  }

  // Cap at 15 lines per axis — structural bays, not every partition
  if (arr.length >= 15) return false;

  // Insert in sorted order
  var idx = 0;
  while (idx < arr.length && arr[idx] < position) idx++;
  arr.splice(idx, 0, position);

  // Generate label if not provided
  if (!label) {
    if (axis === 'X') {
      label = _nextXLabel(idx);
    } else {
      label = String(idx + 1);
      // renumber all Z labels
      for (var j = 0; j < labels.length; j++) labels[j] = String(j + 1);
    }
  }
  labels.splice(idx, 0, label);

  return true;
}

function _nextXLabel(idx) {
  // Generate label like A, A', A'', B, B', etc.
  // If inserting between A and B, use A'
  if (idx > 0 && idx < _xLabels.length) {
    var prev = _xLabels[idx - 1];
    return prev + "'";
  }
  var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return idx < 26 ? letters[idx] : letters[Math.floor(idx / 26) - 1] + letters[idx % 26];
}

function _addGridLine(x0, y0, z0, x1, y1, z1, color, axis, idx) {
  var geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(x0, y0, z0),
    new THREE.Vector3(x1, y1, z1)
  ]);
  var mat = new THREE.LineDashedMaterial({
    color: color, transparent: true, opacity: 0.85,
    dashSize: 1.0, gapSize: 0.4, depthTest: false
  });
  var line = new THREE.Line(geo, mat);
  line.computeLineDistances();
  line.renderOrder = 5;
  if (axis !== undefined) {
    line.userData = { gridLine: true, axis: axis, idx: idx };
  }
  _gridGroup.add(line);
}

function _addDimLabel(text, x, y, z, color) {
  var canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  var ctx = canvas.getContext('2d');
  ctx.font = 'bold 32px monospace';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 32);

  var texture = new THREE.CanvasTexture(canvas);
  var spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  var sprite = new THREE.Sprite(spriteMat);
  sprite.position.set(x, y, z);
  sprite.scale.set(8, 2, 1);
  sprite.renderOrder = 6;
  _gridGroup.add(sprite);
}

function _addBubble(text, x, y, z, color, axis, idx, end) {
  var canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  var ctx = canvas.getContext('2d');
  // Circle
  ctx.beginPath();
  ctx.arc(64, 64, 56, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.stroke();
  // Label
  ctx.font = 'bold 48px monospace';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 64);

  var texture = new THREE.CanvasTexture(canvas);
  var spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  var sprite = new THREE.Sprite(spriteMat);
  sprite.position.set(x, y, z);
  sprite.scale.set(4, 4, 1);
  sprite.renderOrder = 6;
  if (axis !== undefined) {
    sprite.userData = { gridBubble: true, axis: axis, idx: idx, end: end || 'start' };
  }
  _gridGroup.add(sprite);
}

// ── §S267: BOM-driven phase loader ─────────────────────────────────────────
// Phases come ONLY from BOM tree walk. No fallback, no flat query, no invention.
// Tier 1 = structural (Column, Wall, Slab, Beam, Footing) — defines bays
// Tier 2 = openings (Door, Window, Opening) — refines bays
// Tier 3 = finishes (Covering, Roof, Stair, Railing, Plate, Member)
// Tier 4 = infill (Furniture, Proxy, MEP terminals, everything else)

var _BOM_STRUCTURAL = { IfcColumn:1, IfcPile:1, IfcWall:1, IfcWallStandardCase:1,
                        IfcSlab:1, IfcBeam:1, IfcFooting:1 };
var _BOM_OPENINGS   = { IfcDoor:1, IfcWindow:1, IfcOpeningElement:1 };
var _BOM_FINISHES   = { IfcCovering:1, IfcCurtainWall:1, IfcRoof:1, IfcPlate:1,
                        IfcStair:1, IfcStairFlight:1, IfcRailing:1, IfcMember:1 };

function _classifyTier(role) {
  if (_BOM_STRUCTURAL[role]) return 1;
  if (_BOM_OPENINGS[role]) return 2;
  if (_BOM_FINISHES[role]) return 3;
  return 4;
}

function _loadPhases(A) {
  _phases = [];

  // §S267: BOM data lives in the building's extracted DB (m_bom + m_bom_line tables).
  // Use A._bomDb if set (standalone BOM.db), else try A.db (merged extracted DB).
  var bomDb = A._bomDb || A.db;
  if (!bomDb || !window.BOMWalker || !window.VerbExpand) {
    console.log('§DOC_PHASES no BOM data — phases disabled (no db/modules)');
    return;
  }

  // Guard: m_bom table may not exist in older cached extracted DBs
  var boms;
  try { boms = BOMWalker.listBoms(bomDb); } catch(e) {
    console.log('§DOC_PHASES no m_bom table in DB — phases disabled');
    return;
  }
  var building = null;
  for (var bi = 0; bi < boms.length; bi++) {
    if (boms[bi].bomType === 'BUILDING') { building = boms[bi]; break; }
  }
  if (!building) {
    console.warn('§DOC_PHASES no BUILDING BOM in BOM.db');
    return;
  }

  var rootId = building.bomId;

  // BOM walk collects: per floor → per tier → set of IFC classes + storey name.
  // Then we query the extracted DB (A.db) for real GUIDs matching storey + class.
  var floorStack = [];
  var floorBuckets = {};  // bomId → { name, type, storey, 1:Set(class), 2:Set, 3:Set, 4:Set }

  function _cf() { return floorStack.length ? floorStack[floorStack.length - 1] : null; }

  BOMWalker.walk(bomDb, rootId, {
    onSubAssembly: function(ctx) {
      var childType = ctx.childBom ? ctx.childBom.bomType : null;
      if (childType === 'FLOOR' || childType === 'MEP') {
        var bomId = ctx.line.childProductId;
        floorStack.push(bomId);
        if (!floorBuckets[bomId]) {
          floorBuckets[bomId] = { name: bomId, type: childType, storey: ctx.line.storey, 1:{}, 2:{}, 3:{}, 4:{} };
        }
      }
    },
    onSubAssemblyComplete: function(ctx) {
      var childType = ctx.childBom ? ctx.childBom.bomType : null;
      if (childType === 'FLOOR' || childType === 'MEP') floorStack.pop();
    },
    onLeaf: function(ctx) {
      var cf = _cf();
      if (!cf) return;
      if (!floorBuckets[cf]) {
        floorBuckets[cf] = { name: cf, type: 'FLOOR', storey: ctx.line.storey, 1:{}, 2:{}, 3:{}, 4:{} };
      }
      var tier = _classifyTier(ctx.line.role);
      floorBuckets[cf][tier][ctx.line.role] = true;
      // Capture storey from leaf if floor-level storey was null
      if (!floorBuckets[cf].storey && ctx.line.storey) {
        floorBuckets[cf].storey = ctx.line.storey;
      }
    }
  });

  // Convert buckets → phases by querying extracted DB for real GUIDs
  var tierNames = { 1: 'Structure', 2: 'Openings', 3: 'Finishes', 4: 'Infill' };
  var floorOrder = Object.keys(floorBuckets);
  for (var fi = 0; fi < floorOrder.length; fi++) {
    var b = floorBuckets[floorOrder[fi]];
    for (var tier = 1; tier <= 4; tier++) {
      var classes = Object.keys(b[tier]);
      if (!classes.length) continue;

      // Query extracted DB for GUIDs matching this storey + these IFC classes
      var guids = [];
      if (A.db && A.dbQuery && b.storey) {
        var classIn = classes.map(function(c) { return "'" + c.replace(/'/g, "''") + "'"; }).join(',');
        var storeyEsc = b.storey.replace(/'/g, "''");
        guids = A.dbQuery(
          "SELECT guid FROM elements_meta WHERE storey = '" + storeyEsc + "' AND ifc_class IN (" + classIn + ")"
        ).map(function(r) { return r[0]; });
      }

      if (guids.length > 0) {
        _phases.push({
          name: b.name + ' / ' + tierNames[tier],
          disc: tier <= 3 ? 'ARC' : (b.type === 'MEP' ? 'MEP' : 'ARC'),
          ifcClass: tierNames[tier],
          guids: guids,
          tier: tier,
          floor: b.name,
          floorType: b.type
        });
      }
    }
  }

  console.log('§DOC_PHASES bom_tree phases=' + _phases.length + ' root=' + rootId);
}

// ── Materialize phase — show elements for a Gantt step ──────────────────────
function _materializePhase(A, phase) {
  if (!A.scene) return;
  var shown = 0;

  // Build guid lookup set for fast matching
  var guidSet = {};
  for (var i = 0; i < phase.guids.length; i++) {
    guidSet[phase.guids[i]] = true;
  }

  // §S260: BatchedMesh path — use _guidToSlot for per-slot visibility
  for (var k = 0; k < phase.guids.length; k++) {
    var slot = _guidToSlot[phase.guids[k]];
    if (slot) {
      slot.mesh.setVisibleAt(slot.slotId, true);
      shown++;
      continue;
    }
    // InstancedMesh path — restore original matrix
    var inst = _guidToInstance[phase.guids[k]];
    if (inst) {
      inst.mesh.setMatrixAt(inst.index, inst.origMatrix);
      inst.mesh.instanceMatrix.needsUpdate = true;
      inst.mesh.visible = true;
      shown++;
    }
  }

  // Single-mesh path — find meshes in hidden list that match phase guids
  for (var j = _hiddenMeshes.length - 1; j >= 0; j--) {
    var mesh = _hiddenMeshes[j];
    var guid = mesh.userData && mesh.userData.guid;
    if (guid && guidSet[guid]) {
      mesh.visible = true;
      _hiddenMeshes.splice(j, 1);
      shown++;
    }
  }

  _shownCount += shown;
  console.log('§DOC_MATERIALIZE phase=' + phase.name + ' requested=' + phase.guids.length + ' shown=' + shown + ' total=' + _shownCount);
}

// ── HUD update — grid bays, element count, active discipline ───────────────
function _updateHud() {
  // Grid bays section
  var section = typeof document !== 'undefined' && document.getElementById('hud-gridbays-section');
  var body = typeof document !== 'undefined' && document.getElementById('gridbays-body');
  if (section && body) {
    var html = '';
    // X-axis bays (A-B, B-C, ...)
    for (var i = 0; i < _xPositions.length - 1; i++) {
      var span = Math.abs(_xPositions[i + 1] - _xPositions[i]);
      html += '<div style="display:flex;justify-content:space-between;padding:1px 4px">' +
        '<span style="color:#4fc3f7">' + _xLabels[i] + '–' + _xLabels[i + 1] + '</span>' +
        '<span>' + (span * 1000).toFixed(0) + ' mm</span></div>';
    }
    // Z-axis bays (1-2, 2-3, ...)
    for (var j = 0; j < _zPositions.length - 1; j++) {
      var zSpan = Math.abs(_zPositions[j + 1] - _zPositions[j]);
      html += '<div style="display:flex;justify-content:space-between;padding:1px 4px">' +
        '<span style="color:#81c784">' + _zLabels[j] + '–' + _zLabels[j + 1] + '</span>' +
        '<span>' + (zSpan * 1000).toFixed(0) + ' mm</span></div>';
    }
    body.innerHTML = html || '<div style="padding:2px 4px;color:#666">Envelope only</div>';
    section.style.display = 'block';
  }

  // Element count in HUD — reuse s-buildings-done
  var countEl = typeof document !== 'undefined' && document.getElementById('s-buildings-done');
  if (countEl) countEl.textContent = _shownCount;

  // Active discipline badge in status
  if (typeof window !== 'undefined' && window.APP && APP.status) {
    var phaseInfo = _phaseIndex < 0 ? 'Step 0 — envelope' :
      'Phase ' + (_phaseIndex + 1) + ' — ' + _activeDisc;
    APP.status.textContent = phaseInfo + ' | ' + _shownCount + ' elements';
  }

  console.log('§DOC_HUD bays=' + (_xPositions.length - 1 + _zPositions.length - 1) +
    ' elements=' + _shownCount + ' disc=' + _activeDisc +
    ' phase=' + (_phaseIndex < 0 ? 'zero' : _phaseIndex + 1));
}

function _hideHud() {
  var section = typeof document !== 'undefined' && document.getElementById('hud-gridbays-section');
  if (section) section.style.display = 'none';
}

// ── Camera fit to envelope ──────────────────────────────────────────────────
function _fitCamera(A) {
  if (!A._docEnv || !A.camera || !A.controls) return;
  var e = A._docEnv;
  var cx = (e.x0 + e.x1) / 2, cy = (e.y0 + e.y1) / 2, cz = (e.z0 + e.z1) / 2;
  var maxDim = Math.max(e.w, e.h, e.d);
  var dist = maxDim * 1.8;

  A.camera.position.set(cx + dist * 0.6, cy + dist * 0.4, cz + dist * 0.6);
  A.controls.target.set(cx, cy, cz);
  A.controls.update();
}

// ── Dispose helpers ─────────────────────────────────────────────────────────
function _disposeGroup(group) {
  group.traverse(function(obj) {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (obj.material.map) obj.material.map.dispose();
      obj.material.dispose();
    }
  });
}

// ── Rosetta Stone — grid calibration mode ───────────────────────────────────
// When active, user can drag instance copies from template lines to place new
// grid lines. Template lines are always visible (grey=off, gold=on) when Grid ON.
// Corrections are recorded as GRID_CALIBRATE kernel_ops — user IS the gate.
var _calibrationMode = false;
var _calibrations = [];  // [{axis, label, detected, corrected, delta}]
var _rosettaGroup = null;  // sub-group for template lines (inside _gridGroup)
var _rosettaTemplates = []; // [{axis, mesh, line}] — the 3 template lines

/**
 * _renderRosettaTemplates(A) — draw/update the 3 template lines (X, Y, Z)
 * positioned just outside the envelope. Grey when Rosetta OFF, gold when ON.
 */
function _renderRosettaTemplates(A) {
  if (!A._docEnv || !_gridGroup) return;
  var e = A._docEnv;

  // Remove old Rosetta group
  if (_rosettaGroup) {
    _gridGroup.remove(_rosettaGroup);
    _disposeGroup(_rosettaGroup);
  }
  _rosettaGroup = new THREE.Group();
  _rosettaGroup.name = 'RosettaTemplates';
  _gridGroup.add(_rosettaGroup);
  _rosettaTemplates = [];

  var color = _calibrationMode ? 0xffc107 : 0x888888;  // gold or grey
  var opacity = _calibrationMode ? 0.8 : 0.4;
  var dashSize = 0.5, gapSize = 0.3;

  // Template X-line: sits further left, runs along Z — pulled out for clarity
  var txPos = e.x0 - _rosettaExtend;
  var txGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(txPos, e.y0, e.z0 - _rosettaExtend),
    new THREE.Vector3(txPos, e.y0, e.z1 + _rosettaExtend)
  ]);
  var txMat = new THREE.LineDashedMaterial({
    color: color, dashSize: dashSize, gapSize: gapSize,
    transparent: true, opacity: opacity, depthTest: false
  });
  var txLine = new THREE.Line(txGeo, txMat);
  txLine.computeLineDistances();
  txLine.renderOrder = 4;
  txLine.userData = { rosetta: true, axis: 'X', templatePos: txPos };
  _rosettaGroup.add(txLine);
  _rosettaTemplates.push({ axis: 'X', line: txLine, pos: txPos });

  // Template Z-line: sits further forward, runs along X
  var tzPos = e.z0 - _rosettaExtend;
  var tzGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(e.x0 - _rosettaExtend, e.y0, tzPos),
    new THREE.Vector3(e.x1 + _rosettaExtend, e.y0, tzPos)
  ]);
  var tzMat = new THREE.LineDashedMaterial({
    color: color, dashSize: dashSize, gapSize: gapSize,
    transparent: true, opacity: opacity, depthTest: false
  });
  var tzLine = new THREE.Line(tzGeo, tzMat);
  tzLine.computeLineDistances();
  tzLine.renderOrder = 4;
  tzLine.userData = { rosetta: true, axis: 'Z', templatePos: tzPos };
  _rosettaGroup.add(tzLine);
  _rosettaTemplates.push({ axis: 'Z', line: tzLine, pos: tzPos });

  // Template Y-line (height): below ground corner, runs vertically
  var tyPos = e.y0 - 5;
  var tyGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(e.x0 - _rosettaExtend, tyPos, e.z0 - _rosettaExtend),
    new THREE.Vector3(e.x0 - _rosettaExtend, e.y1 + 5, e.z0 - _rosettaExtend)
  ]);
  var tyMat = new THREE.LineDashedMaterial({
    color: color, dashSize: dashSize, gapSize: gapSize,
    transparent: true, opacity: opacity, depthTest: false
  });
  var tyLine = new THREE.Line(tyGeo, tyMat);
  tyLine.computeLineDistances();
  tyLine.renderOrder = 4;
  tyLine.userData = { rosetta: true, axis: 'Y', templatePos: tyPos };
  _rosettaGroup.add(tyLine);
  _rosettaTemplates.push({ axis: 'Y', line: tyLine, pos: tyPos });

  // Label the template lines — further out from grid for clarity
  var labelColor = _calibrationMode ? '#ffc107' : '#888';
  _addRosettaLabel('X', txPos, e.y0, e.z0 - _rosettaExtend - 4, labelColor);
  _addRosettaLabel('Z', e.x0 - _rosettaExtend - 4, e.y0, tzPos, labelColor);
  _addRosettaLabel('Y', e.x0 - _rosettaExtend - 4, tyPos, e.z0 - _rosettaExtend - 4, labelColor);
}

function _addRosettaLabel(text, x, y, z, color) {
  var canvas = document.createElement('canvas');
  canvas.width = 96; canvas.height = 96;
  var ctx = canvas.getContext('2d');
  // Dashed circle
  ctx.beginPath();
  ctx.arc(48, 48, 40, 0, Math.PI * 2);
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.setLineDash([]);
  // Label
  ctx.font = 'bold 36px monospace';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 48, 48);

  var texture = new THREE.CanvasTexture(canvas);
  var mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  var sprite = new THREE.Sprite(mat);
  sprite.position.set(x, y, z);
  sprite.scale.set(2.5, 2.5, 1);
  _rosettaGroup.add(sprite);
}

function setCalibrationMode(on) {
  _calibrationMode = !!on;

  // Update template line colors (gold/grey) and committed grid line colors
  if (_rosettaGroup) {
    _rosettaGroup.traverse(function(obj) {
      if (obj.isLine && obj.material) {
        obj.material.color.setHex(_calibrationMode ? 0xffc107 : 0x888888);
        obj.material.opacity = _calibrationMode ? 0.8 : 0.4;
      }
    });
  }

  // Re-render templates to update labels
  // (full re-render would be cleaner but this is fast enough)
  console.log('§DOC_ROSETTA mode=' + (_calibrationMode ? 'calibrate' : 'design'));

  // Show status message
  if (window.APP && APP.status) {
    APP.status.textContent = _calibrationMode
      ? 'Rosetta Stone ON — drag template lines to place grid lines'
      : 'Rosetta Stone OFF — grid locked';
  }
}

function recordCalibration(axis, label, detected, corrected) {
  var delta = corrected - detected;
  _calibrations.push({ axis: axis, label: label, detected: detected, corrected: corrected, delta: delta });
  console.log('§DOC_ROSETTA_SNAP axis=' + axis + ' label=' + label +
    ' detected=' + detected.toFixed(3) + ' corrected=' + corrected.toFixed(3) +
    ' delta=' + delta.toFixed(3) + 'm');
  // TODO: log as GRID_CALIBRATE kernel_op
}

/**
 * handleRosettaDrag(axis, position, A) — called when user drags from a
 * template line and drops at a position. Creates a new committed grid line.
 * Returns false if Rosetta mode is off (shows status message).
 */
function handleRosettaDrag(axis, position, A) {
  if (!_calibrationMode) {
    if (window.APP && APP.status) {
      APP.status.textContent = 'Turn on Rosetta Stone to place grid lines';
    }
    return false;
  }
  if (!_active || !A) return false;

  // Add the new grid line and re-sort labels for clean sequence
  if (_addGridPosition(axis, position)) {
    _resortLabels();
    _renderGrid(A);
    _updateHud();
    // Log to kernel_ops — this IS the user's creative contribution
    if (window.KernelOps && A.db) {
      try {
        KernelOps.commitOp(A.db, 'GRID_CALIBRATE', JSON.stringify({
          axis: axis, position: Math.round(position * 1000) / 1000
        }), null, null);
      } catch(e) { /* kernel_ops optional */ }
    }
    console.log('§DOC_ROSETTA_PLACE axis=' + axis + ' pos=' + position.toFixed(3) + 'm');
    return true;
  }
  return false;
}

/**
 * setActiveDisc(disc) — set which discipline Next steps through
 */
function setActiveDisc(disc, A) {
  var prev = _activeDisc;
  _activeDisc = disc;
  _phaseIndex = -1;  // reset phase stepper for new discipline
  // Log discipline switch — enables per-discipline sequence recall
  if (window.KernelOps && A && A.db) {
    try {
      KernelOps.commitOp(A.db, 'DISC_SWITCH', JSON.stringify({
        from: prev, to: disc
      }), null, null);
    } catch(e) { /* optional */ }
  }
  console.log('§DOC_DISC active=' + disc + ' prev=' + prev);
  if (window.APP && APP.status) {
    APP.status.textContent = disc + ' selected — press Next to step through';
  }
}

// ── User-initiated grid lines — double-click to add/remove ──────────────────
// §17.9B: minimal envelope grid (2+2). User double-clicks element → grid line
// appears at element position. Double-click again near same line → removes it.
// User controls grid density for printout — many or few, their choice.
function handleElementPick(A, guid) {
  if (!_active || !A || !A.db || !guid) return false;

  // Look up element's class and position
  var rows = A.dbQuery(
    'SELECT m.ifc_class, t.center_x, t.center_y, t.bbox_x, t.bbox_y ' +
    'FROM elements_meta m JOIN element_transforms t ON m.guid = t.guid ' +
    "WHERE m.guid = '" + guid.replace(/'/g, "''") + "'"
  );
  if (!rows.length) return false;

  var cls = rows[0][0];
  var strategy = GRID_STRATEGY[cls];
  if (!strategy || strategy.axes === 'none') {
    if (window.APP && APP.status) {
      APP.status.textContent = cls + ' — no grid line (double-click a wall or column)';
    }
    return false;
  }

  var pt = _ifcToThree(rows[0][1], rows[0][2], 0, A.modelOffset);
  var bx = rows[0][3] || 0;
  var by = rows[0][4] || 0;

  // Check if grid line already exists near this position → toggle (remove)
  var removed = _toggleGridAtPosition(A, pt, bx, by, strategy);
  if (removed) {
    console.log('§DOC_GRID_REMOVE cls=' + cls +
      ' x=' + pt.x.toFixed(2) + ' z=' + pt.z.toFixed(2));
    if (window.APP && APP.status) {
      APP.status.textContent = 'Grid line removed';
    }
    return true;
  }

  // Add new grid line
  var added = 0;
  if (strategy.axes === 'XZ') {
    if (_addGridPosition('X', pt.x)) added++;
    if (_addGridPosition('Z', pt.z)) added++;
  } else if (strategy.axes === 'long') {
    if (bx > by * 1.5) {
      if (_addGridPosition('Z', pt.z)) added++;
    } else if (by > bx * 1.5) {
      if (_addGridPosition('X', pt.x)) added++;
    } else {
      if (_addGridPosition('X', pt.x)) added++;
      if (_addGridPosition('Z', pt.z)) added++;
    }
  }

  if (added > 0) {
    _resortLabels();
    _renderGrid(A);
    _updateHud();
    // Log kernel_op
    if (window.KernelOps && A.db) {
      try {
        KernelOps.commitOp(A.db, 'GRID_ADD', JSON.stringify({
          source: 'user_dblclick', guid: guid, cls: cls,
          axis: strategy.axes, x: pt.x, z: pt.z
        }), null, null);
      } catch(e) { /* optional */ }
    }
    console.log('§DOC_GRID_PICK cls=' + cls + ' added=' + added +
      ' x=' + pt.x.toFixed(2) + ' z=' + pt.z.toFixed(2));
    if (window.APP && APP.status) {
      APP.status.textContent = 'Grid line added from ' + cls;
    }
  }
  return added > 0;
}

/**
 * _toggleGridAtPosition — if a grid line exists within 2m of element, remove it.
 * Returns true if a line was removed (toggle off).
 */
function _toggleGridAtPosition(A, pt, bx, by, strategy) {
  var removed = false;
  var tolerance = 2.0;

  if (strategy.axes === 'XZ' || strategy.axes === 'long') {
    // Check X positions
    if (strategy.axes === 'XZ' || by > bx * 1.5 || (bx <= by * 1.5 && by <= bx * 1.5)) {
      for (var i = _xPositions.length - 1; i >= 0; i--) {
        // Don't remove envelope lines (first and last)
        if (i === 0 && _xPositions.length <= 2) continue;
        if (i === _xPositions.length - 1 && _xPositions.length <= 2) continue;
        if (Math.abs(_xPositions[i] - pt.x) < tolerance) {
          _xPositions.splice(i, 1);
          _xLabels.splice(i, 1);
          removed = true;
          break;
        }
      }
    }
    // Check Z positions
    if (strategy.axes === 'XZ' || bx > by * 1.5 || (bx <= by * 1.5 && by <= bx * 1.5)) {
      for (var j = _zPositions.length - 1; j >= 0; j--) {
        if (j === 0 && _zPositions.length <= 2) continue;
        if (j === _zPositions.length - 1 && _zPositions.length <= 2) continue;
        if (Math.abs(_zPositions[j] - pt.z) < tolerance) {
          _zPositions.splice(j, 1);
          _zLabels.splice(j, 1);
          removed = true;
          break;
        }
      }
    }
  }

  if (removed) {
    _resortLabels();
    _renderGrid(A);
    _updateHud();
    if (window.KernelOps && A.db) {
      try {
        KernelOps.commitOp(A.db, 'GRID_DELETE', JSON.stringify({
          source: 'user_dblclick', x: pt.x, z: pt.z
        }), null, null);
      } catch(e) { /* optional */ }
    }
  }
  return removed;
}

// ── Grid line select-then-drag interaction ──────────────────────────────────
// Click grid line or bubble → select (highlight bright).
// Drag selected line → constrained to perpendicular axis.
// Grab end bubble → rotation mode (other end = pivot).
// Escape or click empty → deselect.
var _selected = null;   // { axis: 'X'|'Z', idx: number, mode: 'drag'|'rotate', pivotEnd: 'start'|'end' }
var _dragStart = null;  // { x, z } world coords at pointerdown
var _dragging = false;
var _origPos = 0;       // original position of selected line before drag
var _raycaster = null;
var _pointer = null;

var _interactionWired = false;
function _initInteraction(A) {
  if (_interactionWired || !A.camera || typeof document === 'undefined') return;
  if (typeof THREE === 'undefined' || !THREE.Raycaster) return;  // skip in test env
  _interactionWired = true;
  _raycaster = new THREE.Raycaster();
  _raycaster.params.Line = { threshold: 1.5 };  // generous threshold for line picking
  _pointer = new THREE.Vector2();

  var canvas = A.renderer && A.renderer.domElement;
  if (!canvas) return;

  canvas.addEventListener('pointerdown', function(ev) {
    if (!_active || !_gridGroup) return;
    _updatePointer(ev, canvas);

    // Raycast against grid group
    _raycaster.setFromCamera(_pointer, A.camera);
    var hits = _raycaster.intersectObjects(_gridGroup.children, false);

    // Find first grid line or bubble hit
    var hit = null;
    for (var i = 0; i < hits.length; i++) {
      var ud = hits[i].object.userData;
      if (ud && (ud.gridLine || ud.gridBubble)) { hit = hits[i]; break; }
    }

    if (!hit) {
      // Click empty → deselect
      if (_selected) _deselectGrid(A);
      return;
    }

    var ud = hit.object.userData;
    var axis = ud.axis;
    var idx = ud.idx;

    if (ud.gridBubble && ud.end) {
      // Bubble grab → rotation mode (other end is pivot)
      _selected = { axis: axis, idx: idx, mode: 'rotate', pivotEnd: ud.end === 'start' ? 'end' : 'start' };
      _highlightGrid(A, axis, idx, 0x00ffff);
      _origPos = axis === 'X' ? _xPositions[idx] : _zPositions[idx];
      if (window.APP && APP.status) {
        var lbl = axis === 'X' ? _xLabels[idx] : _zLabels[idx];
        APP.status.textContent = 'Rotate grid ' + lbl + ' — drag bubble arc';
      }
      console.log('§DOC_GRID_SELECT mode=rotate axis=' + axis + ' idx=' + idx + ' pivot=' + _selected.pivotEnd);
    } else if (_selected && _selected.axis === axis && _selected.idx === idx) {
      // Already selected → start drag
      _dragging = true;
      _dragStart = _worldXZ(hit.point);
      _origPos = axis === 'X' ? _xPositions[idx] : _zPositions[idx];
      // Disable orbit controls during grid drag
      if (A.controls) A.controls.enabled = false;
      console.log('§DOC_GRID_DRAG start axis=' + axis + ' idx=' + idx + ' pos=' + _origPos.toFixed(3));
    } else {
      // First click → select
      if (_selected) _deselectGrid(A);
      _selected = { axis: axis, idx: idx, mode: 'drag' };
      _highlightGrid(A, axis, idx, 0x00ffff);
      _origPos = axis === 'X' ? _xPositions[idx] : _zPositions[idx];
      if (window.APP && APP.status) {
        var lbl2 = axis === 'X' ? _xLabels[idx] : _zLabels[idx];
        var dir = axis === 'X' ? 'left/right' : 'forward/back';
        APP.status.textContent = 'Grid ' + lbl2 + ' selected — click again to drag ' + dir;
      }
      console.log('§DOC_GRID_SELECT mode=drag axis=' + axis + ' idx=' + idx);
    }
  });

  canvas.addEventListener('pointermove', function(ev) {
    if (!_active || !_dragging || !_selected) return;
    _updatePointer(ev, canvas);

    // Project pointer to ground plane (y = e.y0)
    _raycaster.setFromCamera(_pointer, A.camera);
    var plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -A._docEnv.y0);
    var intersection = new THREE.Vector3();
    if (!_raycaster.ray.intersectPlane(plane, intersection)) return;

    // Constrained movement: X lines move along X axis, Z lines along Z axis
    var newPos;
    if (_selected.axis === 'X') {
      newPos = intersection.x;
      _xPositions[_selected.idx] = newPos;
    } else {
      newPos = intersection.z;
      _zPositions[_selected.idx] = newPos;
    }

    // Live re-render grid
    _renderGrid(A);
    _highlightGrid(A, _selected.axis, _selected.idx, 0x00ffff);

    var lbl = _selected.axis === 'X' ? _xLabels[_selected.idx] : _zLabels[_selected.idx];
    var delta = newPos - _origPos;
    if (window.APP && APP.status) {
      APP.status.textContent = 'Dragging ' + lbl + ': ' + (delta >= 0 ? '+' : '') + delta.toFixed(2) + 'm';
    }
  });

  canvas.addEventListener('pointerup', function(ev) {
    if (!_active || !_dragging || !_selected) return;
    _dragging = false;
    if (A.controls) A.controls.enabled = true;

    var axis = _selected.axis;
    var idx = _selected.idx;
    var newPos = axis === 'X' ? _xPositions[idx] : _zPositions[idx];
    var delta = newPos - _origPos;

    if (Math.abs(delta) > 0.01) {
      // Commit the move
      _resortLabels();
      _renderGrid(A);
      _updateHud();

      // Log GRID_MOVE kernel_op
      if (window.KernelOps && A.db) {
        var lbl = axis === 'X' ? _xLabels[idx] : _zLabels[idx];
        try {
          KernelOps.commitOp(A.db, 'GRID_MOVE', JSON.stringify({
            axis: axis, label: lbl,
            old_m: Math.round(_origPos * 1000) / 1000,
            new_m: Math.round(newPos * 1000) / 1000
          }), null, null);
        } catch(e) { /* kernel_ops optional */ }
      }
      console.log('§DOC_GRID_MOVE axis=' + axis + ' old=' + _origPos.toFixed(3) +
        ' new=' + newPos.toFixed(3) + ' delta=' + delta.toFixed(3) + 'm');

      // §S267: Recompose elements after grid drag
      recomposeAfterGridDrag(A);
    }

    _deselectGrid(A);
  });

  // Escape to deselect
  document.addEventListener('keydown', function(ev) {
    if (ev.key === 'Escape' && _selected && _active) {
      if (_dragging) {
        // Cancel drag — restore original position
        if (_selected.axis === 'X') _xPositions[_selected.idx] = _origPos;
        else _zPositions[_selected.idx] = _origPos;
        _dragging = false;
        if (A.controls) A.controls.enabled = true;
        _renderGrid(A);
      }
      _deselectGrid(A);
    }
  });

  console.log('§DOC_INTERACT grid select-then-drag wired');
}

function _updatePointer(ev, canvas) {
  var rect = canvas.getBoundingClientRect();
  _pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  _pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
}

function _worldXZ(point) {
  return { x: point.x, z: point.z };
}

function _highlightGrid(A, axis, idx, color) {
  if (!_gridGroup) return;
  _gridGroup.traverse(function(obj) {
    var ud = obj.userData;
    if (!ud) return;
    if (ud.gridLine && ud.axis === axis && ud.idx === idx) {
      if (obj.material && obj.material.color) {
        obj.material.color.setHex(color);
        obj.material.opacity = 1.0;
        obj.material.dashSize = 0;  // solid line when selected
        obj.material.gapSize = 0;
      }
    }
    if (ud.gridBubble && ud.axis === axis && ud.idx === idx) {
      // Sprite tint — cyan highlight, white to restore
      if (obj.material && obj.material.color) {
        obj.material.color.setHex(color === 0x00ffff ? 0x00ffff : 0xffffff);
        obj.material.opacity = 1.0;
      }
    }
  });
}

function _deselectGrid(A) {
  if (_selected && _gridGroup) {
    // Restore normal line color + dashed style
    _gridGroup.traverse(function(obj) {
      var ud = obj.userData;
      if (!ud || ud.axis !== _selected.axis || ud.idx !== _selected.idx) return;
      if (ud.gridLine && obj.material) {
        obj.material.color.setHex(_lineColor);
        obj.material.opacity = 0.85;
        obj.material.dashSize = 1.0;
        obj.material.gapSize = 0.4;
      }
      if (ud.gridBubble && obj.material) {
        obj.material.color.setHex(0xffffff);  // remove tint
        obj.material.opacity = 0.85;
      }
    });
  }
  _selected = null;
  _dragging = false;
  if (window.APP && APP.status) {
    APP.status.textContent = _active ? (_activeDisc + ' — click grid line to select') : '';
  }
  console.log('§DOC_GRID_DESELECT');
}

// ── Timeline slider — Doc mode phase scrubber ───────────────────────────────
// Shows current phase position, allows forward/back and drag scrubbing.
var _timelineWired = false;

function _showTimeline(A) {
  var el = typeof document !== 'undefined' && document.getElementById('doc-timeline');
  if (!el) return;
  el.style.display = 'block';

  if (_timelineWired) return;
  _timelineWired = true;

  var slider = document.getElementById('tl-slider');
  var back = document.getElementById('tl-back');
  var fwd = document.getElementById('tl-fwd');

  if (fwd) fwd.addEventListener('pointerup', function(ev) {
    ev.stopPropagation();
    if (typeof DocCanvas !== 'undefined') DocCanvas.nextPhase(A);
  });

  if (back) back.addEventListener('pointerup', function(ev) {
    ev.stopPropagation();
    if (typeof DocCanvas !== 'undefined') DocCanvas.prevPhase(A);
  });

  if (slider) slider.addEventListener('input', function(ev) {
    var target = parseInt(ev.target.value);
    _scrubToPhase(A, target);
  });
}

function _hideTimeline() {
  var el = typeof document !== 'undefined' && document.getElementById('doc-timeline');
  if (el) el.style.display = 'none';
}

function _updateTimeline() {
  var slider = typeof document !== 'undefined' && document.getElementById('tl-slider');
  var label = typeof document !== 'undefined' && document.getElementById('tl-label');

  // Get filtered phase count for active discipline
  var filtered = _phases.filter(function(p) {
    return !_activeDisc || p.disc === _activeDisc;
  });
  var total = filtered.length;

  if (slider) {
    slider.max = Math.max(total - 1, 0);
    slider.value = Math.max(_phaseIndex, 0);
  }
  if (label) {
    label.textContent = (_phaseIndex < 0 ? 0 : _phaseIndex + 1) + ' / ' + total;
  }
}

function _scrubToPhase(A, targetIdx) {
  // Reset to step zero and replay up to targetIdx
  if (!_active || !A) return;

  // Hide all elements first (reset)
  _phaseIndex = -1;
  _shownCount = 0;

  // Re-hide all batched/instanced
  for (var bi = 0; bi < _batchedState.length; bi++) {
    var bs = _batchedState[bi];
    for (var si = 0; si < bs.meta.length; si++) {
      bs.mesh.setVisibleAt(bs.meta[si].slotId, false);
    }
  }
  for (var ii = 0; ii < _instancedState.length; ii++) {
    var is2 = _instancedState[ii];
    for (var ij = 0; ij < is2.meta.length; ij++) {
      is2.mesh.setMatrixAt(is2.meta[ij].index, _getZeroMatrix());
      is2.mesh.instanceMatrix.needsUpdate = true;
    }
  }
  // Re-hide single meshes
  // (push back to hidden list handled by clearing visible)

  // Replay phases up to target
  var filtered = _phases.filter(function(p) {
    return !_activeDisc || p.disc === _activeDisc;
  });
  for (var i = 0; i <= targetIdx && i < filtered.length; i++) {
    _materializePhase(A, filtered[i]);
  }
  _phaseIndex = targetIdx;

  // Re-add grid lines from all shown phases
  _xPositions = [A._docEnv.x0, A._docEnv.x1];
  _xLabels = ['A', 'B'];
  _zPositions = [A._docEnv.z0, A._docEnv.z1];
  _zLabels = ['1', '2'];
  for (var g = 0; g <= targetIdx && g < filtered.length; g++) {
    _autoGridFromPhase(A, filtered[g]);
  }
  _renderGrid(A);
  _updateHud();
  _updateTimeline();

  console.log('§DOC_SCRUB to=' + (targetIdx + 1) + '/' + filtered.length +
    ' elements=' + _shownCount);
}

// Zero matrix for hiding instanced meshes during scrub (lazy-init)
var _zeroMatrix = null;
function _getZeroMatrix() {
  if (!_zeroMatrix && typeof THREE !== 'undefined') {
    _zeroMatrix = new THREE.Matrix4();
    _zeroMatrix.set(0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0);
  }
  return _zeroMatrix;
}

/**
 * prevPhase(A) — step backward one phase (reverse the last materialized phase)
 */
function prevPhase(A) {
  if (!_active || !A || _phaseIndex < 0) return;
  _scrubToPhase(A, _phaseIndex - 1);
  console.log('§DOC_PREV phase=' + (_phaseIndex + 1));
}

// ── §S267: Recomposition — verb expansion + grid delta ─────────────────────
// _gridOriginals: snapshot of grid positions at envelope activation (baseline for deltas)
var _gridOriginals = { x: [], z: [] };

/**
 * _snapshotGridOriginals() — called once at activate, records the initial grid positions.
 * All deltas are computed as (current - original).
 */
function _snapshotGridOriginals() {
  _gridOriginals.x = _xPositions.slice();
  _gridOriginals.z = _zPositions.slice();
}

/**
 * _computeGridDeltas() — compute per-axis deltas from original grid positions.
 * Returns { x: [{pos, delta}], z: [{pos, delta}] }
 */
function _computeGridDeltas() {
  var deltas = { x: [], z: [] };
  for (var i = 0; i < _xPositions.length; i++) {
    var orig = i < _gridOriginals.x.length ? _gridOriginals.x[i] : _xPositions[i];
    deltas.x.push({ pos: _xPositions[i], orig: orig, delta: _xPositions[i] - orig });
  }
  for (var j = 0; j < _zPositions.length; j++) {
    var origZ = j < _gridOriginals.z.length ? _gridOriginals.z[j] : _zPositions[j];
    deltas.z.push({ pos: _zPositions[j], orig: origZ, delta: _zPositions[j] - origZ });
  }
  return deltas;
}

/**
 * recomposeAfterGridDrag(A) — re-expand verbs and reposition elements after grid drag.
 *
 * Path A (OOTB, A._bomDb available): Walk BOM, re-expand verb_ref with updated grid coords.
 * Path B (IFC Drop, no BOM.db): Apply delta from nearest grid line to element transforms.
 */
function recomposeAfterGridDrag(A) {
  if (!_active || !A) return;

  var deltas = _computeGridDeltas();
  var anyDelta = deltas.x.some(function(d) { return Math.abs(d.delta) > 0.01; }) ||
                 deltas.z.some(function(d) { return Math.abs(d.delta) > 0.01; });
  if (!anyDelta) return;

  // Path A: OOTB — verb expansion via BOMWalker + VerbExpand
  var _recompBomDb = A._bomDb || A.db;
  if (_recompBomDb && window.BOMWalker && window.VerbExpand) {
    _recomposeOOTB(A, deltas);
    return;
  }

  // Path B: IFC Drop — delta from nearest grid line
  _recomposeIFCDrop(A, deltas);
}

/**
 * _recomposeOOTB(A, deltas) — re-expand verbs with updated grid positions.
 * For FRAME verbs: replace grid coordinates with current positions.
 * For CLUSTER verbs: shift entries near moved grid lines by delta.
 * For TILE verbs: recalculate count from new bay width.
 */
function _recomposeOOTB(A, deltas) {
  var bomDb = A._bomDb || A.db;
  var moved = 0;

  // Collect all leaves with verb_ref
  var leaves = BOMWalker.collectLeaves(bomDb, _findRootBom(bomDb));
  if (!leaves.length) return;

  for (var i = 0; i < leaves.length; i++) {
    var leaf = leaves[i];
    var line = leaf.line;
    if (!line.verbRef) continue;

    var positions = VerbExpand.expandVerb(line.verbRef, line.qty, line.dx, line.dy, line.dz);
    if (!positions.length) continue;

    // Apply grid deltas to expanded positions
    for (var pi = 0; pi < positions.length; pi++) {
      var p = positions[pi];
      // Convert BOM coords (IFC) to Three.js for delta matching
      var threePos = _ifcToThree(p[0], p[1], p[2], A._docEnv ? { x: A._docEnv.ox || 0, y: A._docEnv.oy || 0, z: A._docEnv.oz || 0 } : null);

      // Find nearest X grid line and apply its delta
      var bestXDelta = _findNearestDelta(threePos.x, deltas.x);
      // Find nearest Z grid line and apply its delta
      var bestZDelta = _findNearestDelta(threePos.z, deltas.z);

      if (Math.abs(bestXDelta) > 0.01 || Math.abs(bestZDelta) > 0.01) {
        positions[pi]._threeX = threePos.x + bestXDelta;
        positions[pi]._threeZ = threePos.z + bestZDelta;
        positions[pi]._threeY = threePos.y;
        positions[pi]._moved = true;
        moved++;
      }
    }
  }

  // TODO: Apply positions to scene meshes when guid→mesh mapping is available
  console.log('§RECOMPOSE_OOTB leaves=' + leaves.length + ' moved=' + moved);
}

/**
 * _recomposeIFCDrop(A, deltas) — apply nearest grid delta to element positions.
 */
function _recomposeIFCDrop(A, deltas) {
  if (!A.db) return;
  var moved = 0;

  // Get currently shown phases
  var shownGuids = [];
  var filtered = _phases.filter(function(p) { return !_activeDisc || p.disc === _activeDisc; });
  for (var fi = 0; fi <= _phaseIndex && fi < filtered.length; fi++) {
    shownGuids = shownGuids.concat(filtered[fi].guids);
  }
  if (!shownGuids.length) return;

  for (var gi = 0; gi < shownGuids.length; gi++) {
    var guid = shownGuids[gi];

    // BatchedMesh path
    var slot = _guidToSlot[guid];
    if (slot) {
      var mat = new THREE.Matrix4();
      slot.mesh.getMatrixAt(slot.slotId, mat);
      var pos = new THREE.Vector3();
      pos.setFromMatrixPosition(mat);

      var dxApply = _findNearestDelta(pos.x, deltas.x);
      var dzApply = _findNearestDelta(pos.z, deltas.z);

      if (Math.abs(dxApply) > 0.01 || Math.abs(dzApply) > 0.01) {
        mat.elements[12] += dxApply;
        mat.elements[14] += dzApply;
        slot.mesh.setMatrixAt(slot.slotId, mat);
        slot.mesh.instanceMatrix.needsUpdate = true;
        moved++;
      }
      continue;
    }

    // InstancedMesh path
    var inst = _guidToInstance[guid];
    if (inst) {
      var imat = new THREE.Matrix4();
      inst.mesh.getMatrixAt(inst.index, imat);
      var ipos = new THREE.Vector3();
      ipos.setFromMatrixPosition(imat);

      var idxApply = _findNearestDelta(ipos.x, deltas.x);
      var idzApply = _findNearestDelta(ipos.z, deltas.z);

      if (Math.abs(idxApply) > 0.01 || Math.abs(idzApply) > 0.01) {
        imat.elements[12] += idxApply;
        imat.elements[14] += idzApply;
        inst.mesh.setMatrixAt(inst.index, imat);
        inst.mesh.instanceMatrix.needsUpdate = true;
        moved++;
      }
      continue;
    }

    // Single-mesh path
    var scene = A.scene;
    if (scene) {
      scene.traverse(function(obj) {
        if (obj.userData && obj.userData.guid === guid && obj.isMesh) {
          var sdx = _findNearestDelta(obj.position.x, deltas.x);
          var sdz = _findNearestDelta(obj.position.z, deltas.z);
          if (Math.abs(sdx) > 0.01 || Math.abs(sdz) > 0.01) {
            obj.position.x += sdx;
            obj.position.z += sdz;
            moved++;
          }
        }
      });
    }
  }

  console.log('§RECOMPOSE_IFC_DROP guids=' + shownGuids.length + ' moved=' + moved);
}

/**
 * _findNearestDelta(pos, deltaArray) — find the nearest grid line delta for a position.
 * @param {number} pos — element position in Three.js coords
 * @param {Array} deltaArray — [{pos, orig, delta}]
 * @returns {number} delta to apply (0 if no nearby grid line moved)
 */
function _findNearestDelta(pos, deltaArray) {
  if (!deltaArray.length) return 0;
  var best = 0;
  var bestDist = Infinity;
  for (var i = 0; i < deltaArray.length; i++) {
    var d = deltaArray[i];
    if (Math.abs(d.delta) < 0.01) continue; // no movement on this line
    var dist = Math.abs(pos - d.orig);
    if (dist < bestDist) {
      bestDist = dist;
      best = d.delta;
    }
  }
  // Only apply if element is reasonably close to a grid line (within 2m)
  return bestDist < 2.0 ? best : 0;
}

/**
 * _findRootBom(bomDb) — find the BUILDING-level root BOM in the database.
 */
function _findRootBom(bomDb) {
  if (!bomDb) return null;
  var boms = BOMWalker.listBoms(bomDb);
  for (var i = 0; i < boms.length; i++) {
    if (boms[i].bomType === 'BUILDING') return boms[i].bomId;
  }
  // Fallback: first BOM
  return boms.length ? boms[0].bomId : null;
}

// ── Public API ──────────────────────────────────────────────────────────────
window.DocCanvas = {
  activate: activate,
  deactivate: deactivate,
  toggleGrid: toggleGrid,
  nextPhase: nextPhase,
  prevPhase: prevPhase,
  handleElementPick: handleElementPick,
  setCalibrationMode: setCalibrationMode,
  recordCalibration: recordCalibration,
  handleRosettaDrag: handleRosettaDrag,
  setActiveDisc: setActiveDisc,
  // Test-only: inject phases without BOM.db (materialize tests)
  _setPhases: function(p) { _phases = p; },
  isActive: function() { return _active; },
  isCalibrating: function() { return _calibrationMode; },
  getCalibrations: function() { return _calibrations.slice(); },
  getActiveDisc: function() { return _activeDisc; },
  recompose: recomposeAfterGridDrag,
  getGridState: function() {
    return {
      xPositions: _xPositions.slice(),
      zPositions: _zPositions.slice(),
      xLabels: _xLabels.slice(),
      zLabels: _zLabels.slice()
    };
  }
};

})(window);
