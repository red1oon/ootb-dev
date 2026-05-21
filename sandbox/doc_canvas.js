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
  IfcDoor:               { axes: 'none', desc: 'door → child of wall' },
  IfcWindow:             { axes: 'none', desc: 'window → child of wall' },
  IfcOpening:            { axes: 'none', desc: 'opening → child of wall' },
  IfcOpeningElement:     { axes: 'none', desc: 'opening → child of wall' },
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

  // Reset phase stepper
  _phaseIndex = -1;
  _shownCount = 0;
  _loadPhases(A);

  // Position camera to see envelope
  _fitCamera(A);

  // Update HUD for Doc mode — step zero, 0 elements
  _updateHud();

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

  // Hide Doc HUD sections
  _hideHud();
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

  // §6.4: auto-add grid lines from newly appeared elements
  var linesAdded = _autoGridFromPhase(A, phase);

  // Re-render grid if new lines were added
  if (linesAdded > 0) _renderGrid(A);

  // Update HUD with new grid bays + element count
  _updateHud();

  console.log('§DOC_NEXT phase=' + (_phaseIndex + 1) + '/' + filtered.length +
    ' disc=' + (phase.disc || '?') + ' name=' + phase.name +
    ' elements=' + phase.guids.length + ' newGridLines=' + linesAdded);
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

    if (strategy.axes === 'XZ') {
      // Grid intersection — add both axes
      if (_addGridPosition('X', pt.x)) added++;
      if (_addGridPosition('Z', pt.z)) added++;
    } else if (strategy.axes === 'long') {
      // Wall centerline — perpendicular to long axis
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
  var env = A._bom.envelope;
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
  A._docEnv = { x0: x0, x1: x1, y0: y0, y1: y1, z0: z0, z1: z1, w: w, h: h, d: d };

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

  // ── Draw X grid lines (lettered) ──
  for (var a = 0; a < _xPositions.length; a++) {
    var xp = _xPositions[a];
    _addGridLine(xp, e.y0, e.z0 - _extend, xp, e.y0, e.z1 + _extend, _lineColor);
    _addBubble(_xLabels[a] || String.fromCharCode(65 + a), xp, e.y0, e.z0 - _extend - 5, _bubbleColor);
  }

  // ── Draw Z grid lines (numbered) ──
  for (var b = 0; b < _zPositions.length; b++) {
    var zp = _zPositions[b];
    _addGridLine(e.x0 - _extend, e.y0, zp, e.x1 + _extend, e.y0, zp, _lineColor);
    _addBubble(_zLabels[b] || String(b + 1), e.x0 - _extend - 5, e.y0, zp, _bubbleColor);
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

  // Cap at 30 lines per axis to prevent visual clutter
  if (arr.length >= 30) return false;

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

function _addGridLine(x0, y0, z0, x1, y1, z1, color) {
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

function _addBubble(text, x, y, z, color) {
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
  _gridGroup.add(sprite);
}

// ── Gantt phase loader ──────────────────────────────────────────────────────
function _loadPhases(A) {
  _phases = [];

  // Check if building has Gantt data (tasks table)
  var hasTasks = A.dbQuery("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'");
  if (hasTasks.length) {
    // Load phases from tasks table, ordered by start
    var tasks = A.dbQuery(
      'SELECT t.task_id, t.name FROM tasks t ' +
      'ORDER BY t.start_date, t.task_id'
    );
    for (var i = 0; i < tasks.length; i++) {
      var taskId = tasks[i][0];
      var taskName = tasks[i][1] || 'Phase ' + (i + 1);
      // Get elements for this task
      var elems = A.dbQuery(
        'SELECT guid FROM task_elements WHERE task_id = \'' + taskId + '\''
      );
      if (elems.length) {
        _phases.push({
          name: taskName,
          guids: elems.map(function(e) { return e[0]; })
        });
      }
    }
    console.log('§DOC_PHASES loaded=' + _phases.length + ' from tasks table');
  }

  if (!_phases.length) {
    // Group by storey × discipline × ifc_class for fine-grained stepping.
    // Each phase is one ifc_class within one discipline within one storey.
    // Tagged with disc so nextPhase can filter by active discipline.
    var discOrder = ['STR', 'ARC', 'MEP', 'FP', 'ELEC', 'ACMV', 'PLMB'];
    if (A._bom && A._bom.storeys) {
      for (var si = 0; si < A._bom.storeys.length; si++) {
        var storey = A._bom.storeys[si];
        for (var di = 0; di < discOrder.length; di++) {
          var disc = storey.disciplines.find(function(d) { return d.name === discOrder[di]; });
          if (disc) {
            for (var ci = 0; ci < disc.classes.length; ci++) {
              var cls = disc.classes[ci];
              if (cls.elements.length) {
                _phases.push({
                  name: storey.name + ' / ' + discOrder[di] + ' / ' + cls.ifc_class,
                  disc: discOrder[di],
                  ifcClass: cls.ifc_class,
                  guids: cls.elements
                });
              }
            }
          }
        }
      }
    }
    console.log('§DOC_PHASES built=' + _phases.length + ' (storey×disc×class)');
  }
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

// ── Public API ──────────────────────────────────────────────────────────────
window.DocCanvas = {
  activate: activate,
  deactivate: deactivate,
  toggleGrid: toggleGrid,
  nextPhase: nextPhase,
  setCalibrationMode: setCalibrationMode,
  recordCalibration: recordCalibration,
  handleRosettaDrag: handleRosettaDrag,
  setActiveDisc: setActiveDisc,
  isActive: function() { return _active; },
  isCalibrating: function() { return _calibrationMode; },
  getCalibrations: function() { return _calibrations.slice(); },
  getActiveDisc: function() { return _activeDisc; },
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
