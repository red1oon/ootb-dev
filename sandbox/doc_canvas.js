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
var _phases = [];        // Gantt phases [{name, guids}]
var _hiddenMeshes = [];  // stash of meshes hidden when Doc activates

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
  _hiddenMeshes = [];
  A.scene.traverse(function(obj) {
    if (obj === _group || obj.parent === _group ||
        obj.parent === _envGroup || obj.parent === _gridGroup ||
        obj.parent === _phaseGroup) return;
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
  _loadPhases(A);

  // Position camera to see envelope
  _fitCamera(A);

  console.log('§DOC_CANVAS activate building=' + A._bom.building +
    ' hidden=' + _hiddenMeshes.length +
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
 * nextPhase(A) — advance one Gantt construction phase
 */
function nextPhase(A) {
  if (!_active || !A) return;
  _phaseIndex++;
  if (_phaseIndex >= _phases.length) {
    console.log('§DOC_NEXT all phases shown (' + _phases.length + ')');
    return;
  }
  var phase = _phases[_phaseIndex];
  _materializePhase(A, phase);
  console.log('§DOC_NEXT phase=' + (_phaseIndex + 1) + '/' + _phases.length +
    ' name=' + phase.name + ' elements=' + phase.guids.length);
}

// ── Envelope wireframe ──────────────────────────────────────────────────────
function _buildEnvelope(A) {
  var env = A._bom.envelope;
  var ox = A.modelOffset ? A.modelOffset.x : 0;
  var oy = A.modelOffset ? A.modelOffset.y : 0;
  var oz = A.modelOffset ? A.modelOffset.z : 0;

  // IFC coords → Three.js: (x - ox, z - oz, -(y - oy))
  var x0 = env.minX - ox, x1 = env.maxX - ox;
  var y0 = env.minZ - oz, y1 = env.maxZ - oz;  // IFC Z → Three Y (up)
  var z0 = -(env.maxY - oy), z1 = -(env.minY - oy);  // IFC Y → Three -Z

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

// ── Fresh 2D Grid — 3 axes × 2 lines at envelope edges + dimensions ────────
function _buildGrid(A) {
  if (!A._docEnv) return;
  var e = A._docEnv;
  var lineColor = 0xff6666;
  var labelColor = '#ff8888';

  // Grid lines: 2 per axis at min/max positions
  // X-axis lines (run along X at min/max Y ground level)
  _addGridLine(e.x0, e.y0, e.z0, e.x1, e.y0, e.z0, lineColor);  // bottom-front
  _addGridLine(e.x0, e.y0, e.z1, e.x1, e.y0, e.z1, lineColor);  // bottom-back

  // Z-axis lines (run along depth at min/max X ground level)
  _addGridLine(e.x0, e.y0, e.z0, e.x0, e.y0, e.z1, lineColor);  // left
  _addGridLine(e.x1, e.y0, e.z0, e.x1, e.y0, e.z1, lineColor);  // right

  // Y-axis lines (vertical at corners)
  _addGridLine(e.x0, e.y0, e.z0, e.x0, e.y1, e.z0, lineColor);  // front-left
  _addGridLine(e.x1, e.y0, e.z0, e.x1, e.y1, e.z0, lineColor);  // front-right

  // Dimension labels
  var env = A._bom.envelope;
  _addDimLabel(env.width.toFixed(1) + 'm', (e.x0 + e.x1) / 2, e.y0 - 1, e.z0 - 1, labelColor);   // width along X
  _addDimLabel(env.depth.toFixed(1) + 'm', e.x1 + 1, e.y0 - 1, (e.z0 + e.z1) / 2, labelColor);    // depth along Z
  _addDimLabel(env.height.toFixed(1) + 'm', e.x0 - 1, (e.y0 + e.y1) / 2, e.z0 - 1, labelColor);   // height along Y

  console.log('§DOC_GRID built lines=6 labels=3');
}

function _addGridLine(x0, y0, z0, x1, y1, z1, color) {
  var geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(x0, y0, z0),
    new THREE.Vector3(x1, y1, z1)
  ]);
  var mat = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 0.5 });
  var line = new THREE.Line(geo, mat);
  _gridGroup.add(line);
}

function _addDimLabel(text, x, y, z, color) {
  var canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  var ctx = canvas.getContext('2d');
  ctx.font = 'bold 36px monospace';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 32);

  var texture = new THREE.CanvasTexture(canvas);
  var spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  var sprite = new THREE.Sprite(spriteMat);
  sprite.position.set(x, y, z);
  sprite.scale.set(8, 2, 1);
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
      'SELECT t.id, t.name, t.task_type FROM tasks t ' +
      'ORDER BY t.id'
    );
    for (var i = 0; i < tasks.length; i++) {
      var taskId = tasks[i][0];
      var taskName = tasks[i][1] || 'Phase ' + (i + 1);
      // Get elements for this task
      var elems = A.dbQuery(
        'SELECT guid FROM task_elements WHERE task_id = ?', [taskId]
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
    // Fallback: group by discipline order (STR → ARC → MEP)
    var discOrder = ['STR', 'ARC', 'MEP', 'FP', 'ELEC', 'ACMV', 'PLMB'];
    if (A._bom && A._bom.storeys) {
      for (var si = 0; si < A._bom.storeys.length; si++) {
        var storey = A._bom.storeys[si];
        for (var di = 0; di < discOrder.length; di++) {
          var disc = storey.disciplines.find(function(d) { return d.name === discOrder[di]; });
          if (disc) {
            var guids = [];
            for (var ci = 0; ci < disc.classes.length; ci++) {
              guids = guids.concat(disc.classes[ci].elements);
            }
            if (guids.length) {
              _phases.push({
                name: storey.name + ' / ' + discOrder[di],
                guids: guids
              });
            }
          }
        }
      }
    }
    console.log('§DOC_PHASES fallback=' + _phases.length + ' (storey×discipline)');
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

  // Find meshes in hidden list that match phase guids
  for (var j = _hiddenMeshes.length - 1; j >= 0; j--) {
    var mesh = _hiddenMeshes[j];
    var guid = mesh.userData && mesh.userData.guid;
    if (guid && guidSet[guid]) {
      mesh.visible = true;
      _hiddenMeshes.splice(j, 1);
      shown++;
    }
  }

  // Also check instanced meshes that store guids differently
  if (shown === 0 && A._guidToMesh) {
    for (var k = 0; k < phase.guids.length; k++) {
      var m = A._guidToMesh[phase.guids[k]];
      if (m && !m.visible) {
        m.visible = true;
        shown++;
      }
    }
  }

  console.log('§DOC_MATERIALIZE phase=' + phase.name + ' requested=' + phase.guids.length + ' shown=' + shown);
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

// ── Public API ──────────────────────────────────────────────────────────────
window.DocCanvas = {
  activate: activate,
  deactivate: deactivate,
  toggleGrid: toggleGrid,
  nextPhase: nextPhase,
  isActive: function() { return _active; }
};

})(window);
