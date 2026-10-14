/**
 * Polygon Layout
 *
 * Aaron's vision: Bands as polygon centers, members at vertices.
 * Polygons share vertices when a member is in multiple bands.
 * Popularity weights determine parent influence (Father/Mother/Step).
 *
 * Model:
 * - Each band is a polygon center (gold in sketch)
 * - Its members are vertices (purple dots)
 * - Polygon shape adapts to N: 4 members = square, 5 = pentagon, etc.
 * - Shared vertices: a member in 2 bands is a vertex in both polygons
 * - Popularity weights: Father (highest pop) pulls hardest, Mother second, Step less
 * - Rendering: relax polygons into organic constellations
 *
 * Used for 2° and 3° views (maxHops <= 3). 4-6° views use radialLayout.
 * Validated on live data: Home 2° 0 crossings, CH 2° 0, Buckcherry 2° 0,
 * Home 3° 0, Buckcherry 3° 2. Polygon beats ring for ALL views.
 */

/**
 * Calculate polygon vertex positions for N points around a center.
 * Returns array of {x, y} offsets.
 */
export function polygonVertices(count, radius, rotation = 0) {
  if (count <= 0) return [];
  if (count === 1) return [{ x: Math.cos(rotation) * radius, y: Math.sin(rotation) * radius }];
  if (count === 2) {
    return [
      { x: Math.cos(rotation) * radius, y: Math.sin(rotation) * radius },
      { x: Math.cos(rotation + Math.PI) * radius, y: Math.sin(rotation + Math.PI) * radius },
    ];
  }
  const points = [];
  for (let i = 0; i < count; i++) {
    const angle = rotation + (i / count) * Math.PI * 2;
    points.push({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    });
  }
  return points;
}

/**
 * Calculate polygon radius for N vertices with minimum separation.
 * Regular N-gon: side length = 2 * R * sin(π/N)
 * For side length >= minSeparation: R >= minSeparation / (2 * sin(π/N))
 */
export function polygonRadius(count, minSeparation) {
  if (count <= 0) return 0;
  if (count === 1) return minSeparation * 1.0;
  if (count === 2) return minSeparation * 0.6;
  // Ensure radius >= minSeparation (parent-child distance)
  const sideBased = (minSeparation / (2 * Math.sin(Math.PI / count))) * 1.05;
  return Math.max(sideBased, minSeparation);
}

/**
 * Get popularity weight for a band.
 * Returns 0-1 weight based on popularity_score.
 * Higher popularity = higher weight = more pull on shared vertices.
 */
export function popularityWeight(popularityScore, maxPopularity = 100) {
  if (!popularityScore || popularityScore <= 0) return 0.1; // Minimum weight
  return Math.min(popularityScore / maxPopularity, 1.0);
}

/**
 * Polygon layout.
 * 
 * @param {Object} params
 * @param {Array} params.nodes - Array of {id, name, type, popularity_score}
 * @param {Array} params.links - Array of {source, target}
 * @param {string} params.anchorId - ID of anchor node
 * @param {number} params.minSeparation - Minimum distance between nodes
 * @returns {Map} positions - Map of id -> {x, y}
 */
export function polygonLayout({ nodes, links, anchorId, minSeparation = 30 }) {
  // ORDER-INDEPENDENCE: Sort nodes and links by ID before processing.
  // The live site builds the graph in a different order than test harnesses
  // (API order vs internal graph order). Without sorting, the same graph
  // gives different layouts depending on input order — my test said Home=1
  // crossing, live showed 7, both deterministic but different.
  // Sorting ensures identical input → identical output regardless of
  // the order the caller passes nodes/links in.
  const sortedNodes = [...nodes].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const sortedLinks = [...links].sort((a, b) => {
    const aSrc = typeof a.source === 'object' ? a.source.id : a.source;
    const aTgt = typeof a.target === 'object' ? a.target.id : a.target;
    const bSrc = typeof b.source === 'object' ? b.source.id : b.source;
    const bTgt = typeof b.target === 'object' ? b.target.id : b.target;
    const srcCmp = String(aSrc).localeCompare(String(bSrc));
    if (srcCmp !== 0) return srcCmp;
    return String(aTgt).localeCompare(String(bTgt));
  });
  // Use sorted arrays from here on
  nodes = sortedNodes;
  links = sortedLinks;

  const positions = new Map();
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  // Track claim popularity: for each node, the max popularity of bands that placed it
  // Higher popularity = stronger claim = more pull on shared vertices
  const claimPopularity = new Map();
  
  // Build adjacency: node -> list of neighbors
  const adjacency = new Map();
  links.forEach(link => {
    const a = typeof link.source === 'object' ? link.source.id : link.source;
    const b = typeof link.target === 'object' ? link.target.id : link.target;
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a).push(b);
    adjacency.get(b).push(a);
  });
  
  // BFS from anchor, placing polygons
  const visited = new Set();
  const queue = [{ id: anchorId, x: 0, y: 0, parentX: 0, parentY: 0 }];
  positions.set(anchorId, { x: 0, y: 0 });
  visited.add(anchorId);
  // Anchor has no claim popularity (it's the root)
  claimPopularity.set(anchorId, 0);
  
  while (queue.length > 0) {
    const current = queue.shift();
    const currentPos = positions.get(current.id);
    const neighbors = adjacency.get(current.id) || [];
    const unvisited = neighbors.filter(n => !visited.has(n));
    
    if (unvisited.length === 0) continue;
    
    // Calculate placement for unvisited neighbors around current
    // KEY DISTINCTION (Aaron's clarification):
    // - When current is a BAND, neighbors are MEMBERS → use POLYGON placement
    //   (members form polygon around band: 4=square, 5=pentagon, etc.)
    // - When current is a MEMBER (like Aaron), neighbors are BANDS → use LINE placement
    //   (bands in a line perpendicular to parent direction, spacing 2.5x).
    //   Line placement is the only topology achieving 0 crossings for Home.
    //   Polygon placement for hubs was tested and made things worse.
    const N = unvisited.length;
    const currentNode = nodeMap.get(current.id);
    const isBand = currentNode?.type === 'band';
    let radius, vertices;
    if (isBand) {
      // BAND → MEMBERS: Polygon placement (core model)
      radius = polygonRadius(N, minSeparation);
      const dxToParent = current.parentX - currentPos.x;
      const dyToParent = current.parentY - currentPos.y;
      const angleToParent = Math.atan2(dyToParent, dxToParent);
      const rotation = angleToParent + Math.PI / N;
      vertices = polygonVertices(N, radius, rotation);
    } else {
      // MEMBER → BANDS: Circle placement with LARGE radius
      // Give bands plenty of room so their member-polygons don't overlap
      // Radius scales with N to keep bands separated
      // ORDER BANDS: Place bands that share members ADJACENT, not opposite
      // This prevents shared vertices (like Matt) from having edges that cross
      // e.g., BBRU and Ka-Chunk share Matt, so they should be adjacent, not opposite corners
      radius = Math.max(minSeparation * 3, N * minSeparation * 0.8);
      const dxToParent = current.parentX - currentPos.x;
      const dyToParent = current.parentY - currentPos.y;
      const angleToParent = Math.atan2(dyToParent, dxToParent);
      const rotation = angleToParent + Math.PI / N;
      // Sort unvisited bands: group bands that share members
      // Build a map of band -> set of its members (from links)
      const bandMembers = new Map();
      unvisited.forEach(bandId => {
        const members = new Set();
        links.forEach(l => {
          const a = typeof l.source === 'object' ? l.source.id : l.source;
          const b = typeof l.target === 'object' ? l.target.id : l.target;
          if (a === bandId) members.add(b);
          if (b === bandId) members.add(a);
        });
        bandMembers.set(bandId, members);
      });
      // Order bands by greedy: start with first, then pick next band sharing most members with previous
      const ordered = [];
      const remaining = new Set(unvisited);
      let currentBand = unvisited[0];
      ordered.push(currentBand);
      remaining.delete(currentBand);
      while (remaining.size > 0) {
        let bestNext = null;
        let bestShared = -1;
        for (const candidate of remaining) {
          const prevMembers = bandMembers.get(ordered[ordered.length - 1]);
          const candMembers = bandMembers.get(candidate);
          let shared = 0;
          candMembers.forEach(m => { 
            // Exclude anchor (Aaron is in all bands, so he doesn't count for adjacency)
            // Only count NON-ANCHOR shared members (like Matt, Shane)
            if (m !== anchorId && prevMembers.has(m)) shared++; 
          });
          if (shared > bestShared) {
            bestShared = shared;
            bestNext = candidate;
          }
        }
        if (bestNext) {
          ordered.push(bestNext);
          remaining.delete(bestNext);
        } else {
          // Fallback: just take first remaining
          const first = [...remaining][0];
          ordered.push(first);
          remaining.delete(first);
        }
      }
      // LINE placement (original V6 - Aaron approved)
      // Polygon placement for hubs was tested and made things worse:
      // Polygon for N>4 bands → Home 0→1, CH 0→2, FF 27→36, Suicidal 23→31.
      // Polygon around hub members puts bands on opposite sides, causing crossings.
      // Line placement is better even for hubs — the refinement handles it.
      //
      // Polygon beats ring for ALL views (even hub-heavy: FF 27 vs ring 61,
      // Suicidal 23 vs ring 33). No view-level selection needed.
      
      // Line direction: perpendicular to parent direction (original V6)
      const lineDirX = Math.cos(rotation + Math.PI / 2);
      const lineDirY = Math.sin(rotation + Math.PI / 2);
      const spacing = minSeparation * 2.5; // Original V6 spacing
      const startOffset = -((N - 1) / 2) * spacing;
      const lineVertices = [];
      for (let i = 0; i < N; i++) {
        const offset = startOffset + i * spacing;
        lineVertices.push({
          x: lineDirX * offset,
          y: lineDirY * offset,
        });
      }
      // Reorder unvisited to match ordered, and use line vertices
      unvisited.length = 0;
      ordered.forEach(id => unvisited.push(id));
      vertices = lineVertices;
    }
    
    unvisited.forEach((neighborId, index) => {
      const vertex = vertices[index] || { x: 0, y: 0 };
      const x = currentPos.x + vertex.x;
      const y = currentPos.y + vertex.y;
      
      // Check if neighbor is already placed (shared vertex)
      if (positions.has(neighborId)) {
        // SHARED VERTEX: Node is in multiple contexts
        // FIX FOR CH TOPOLOGY: Distinguish shared BANDS from shared MEMBERS.
        // - Shared MEMBER (person in multiple bands, e.g., Matt in BBRU/Ka-Chunk):
        //   Blend by popularity — the member is pulled between their bands.
        // - Shared BAND (band with multiple members, e.g., Split Enz with Neil + Tim Finn):
        //   DON'T blend — keep first placement. The band was placed when visiting
        //   its first member (highest-degree member visited first). Blending pulls
        //   it between members, landing in crossing positions. First placement wins.
        const neighborNode = nodeMap.get(neighborId);
        const neighborIsBand = neighborNode?.type === 'band';
        if (neighborIsBand) {
          // Shared band: keep original position, do not blend
          return;
        }
        // Shared MEMBER: blend by popularity (original logic)
        // Popularity-weighted position: blend existing position with new ideal position
        // Father (higher popularity) pulls harder than Mother/Step (lower popularity)
        const currentNode = nodeMap.get(current.id);
        const currentPop = currentNode?.popularity_score || 0;
        const existingPop = claimPopularity.get(neighborId) || 0;
        const existingPos = positions.get(neighborId);
        
        // If current band is more popular, pull toward new position
        // If current band is less popular, keep mostly at existing position
        // Weight: currentPop / (currentPop + existingPop) determines pull strength
        const totalPop = currentPop + existingPop;
        let pull = 0.5; // Default: equal pull (meet in middle)
        if (totalPop > 0) {
          pull = currentPop / totalPop;
          // pull = 0.5 means equal popularity, meet in middle
          // pull > 0.5 means current band is more popular, move toward new position
          // pull < 0.5 means current band is less popular, stay near existing
        }
        // If both have 0 popularity, pull = 0.5 (meet in middle) — this is the fix
        // Previously, 0/0 would keep existing position, stranding shared vertices on one side
        const newX = existingPos.x * (1 - pull) + x * pull;
        const newY = existingPos.y * (1 - pull) + y * pull;
        positions.set(neighborId, { x: newX, y: newY });
        // Update claim popularity to max (strongest band wins)
        claimPopularity.set(neighborId, Math.max(existingPop, currentPop));
        return;
      }
      
      // First-time placement
      positions.set(neighborId, { x, y });
      visited.add(neighborId);
      // Record claim popularity from current band
      const currentNode = nodeMap.get(current.id);
      claimPopularity.set(neighborId, currentNode?.popularity_score || 0);
      queue.push({ id: neighborId, x, y, parentX: currentPos.x, parentY: currentPos.y });
    });
  }
  
  // Place any unvisited nodes (disconnected components)
  // DETERMINISTIC: Use node index for angle, not Math.random().
  // Math.random() made the layout non-deterministic: same input gave
  // 1-7 crossings across runs for CH. Deterministic placement ensures
  // everyone sees the same layout, and tests are reproducible.
  let disconnectedIndex = 0;
  const disconnectedCount = nodes.filter(n => !positions.has(n.id)).length;
  nodes.forEach(node => {
    if (!positions.has(node.id)) {
      // Deterministic angle: spread disconnected nodes evenly around circle
      const angle = (disconnectedIndex / Math.max(1, disconnectedCount)) * Math.PI * 2;
      const dist = 500 + (disconnectedIndex % 5) * 50; // Deterministic variation
      positions.set(node.id, {
        x: Math.cos(angle) * dist,
        y: Math.sin(angle) * dist,
      });
      disconnectedIndex++;
    }
  });
  
  // REFINEMENT: separation + crossing reduction
  // This is the polygon equivalent of the ring layout's refineRingAngles + relaxLayout
  refinePolygon(positions, links, minSeparation);
  
  return positions;
}

/**
 * Check if two line segments intersect (interior crossing, not endpoint touch).
 */
function segmentsIntersect(p1, p2, p3, p4) {
  const d = (p4.y - p3.y) * (p2.x - p1.x) - (p4.x - p3.x) * (p2.y - p1.y);
  if (Math.abs(d) < 1e-9) return false; // Parallel
  const ua = ((p4.x - p3.x) * (p1.y - p3.y) - (p4.y - p3.y) * (p1.x - p3.x)) / d;
  const ub = ((p2.x - p1.x) * (p1.y - p3.y) - (p2.y - p1.y) * (p1.x - p3.x)) / d;
  return ua > 0.01 && ua < 0.99 && ub > 0.01 && ub < 0.99;
}

/**
 * Count edge-edge crossings in the current layout.
 */
function countCrossings(positions, links) {
  let crossings = 0;
  for (let i = 0; i < links.length; i++) {
    for (let j = i + 1; j < links.length; j++) {
      const l1 = links[i];
      const l2 = links[j];
      const a1 = typeof l1.source === 'object' ? l1.source.id : l1.source;
      const b1 = typeof l1.target === 'object' ? l1.target.id : l1.target;
      const a2 = typeof l2.source === 'object' ? l2.source.id : l2.source;
      const b2 = typeof l2.target === 'object' ? l2.target.id : l2.target;
      if (a1 === a2 || a1 === b2 || b1 === a2 || b1 === b2) continue; // Shared endpoint
      const p1 = positions.get(a1);
      const p2 = positions.get(b1);
      const p3 = positions.get(a2);
      const p4 = positions.get(b2);
      if (p1 && p2 && p3 && p4 && segmentsIntersect(p1, p2, p3, p4)) crossings++;
    }
  }
  return crossings;
}

/**
 * Refine polygon layout: enforce separation and reduce crossings.
 * 
 * Phase 1: Separation — push nodes apart if too close
 * Phase 2: Crossing reduction — try small nudges to resolve crossings
 * 
 * @param {Map} positions - Map of id -> {x, y} (mutated in place)
 * @param {Array} links - Array of {source, target}
 * @param {number} minSeparation - Minimum distance between nodes
 */
export function refinePolygon(positions, links, minSeparation) {
  const ids = [...positions.keys()];
  
  // Phase 1: Separation — iterate until all nodes are at least minSeparation apart
  // Or max iterations reached
  for (let iter = 0; iter < 100; iter++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = positions.get(ids[i]);
        const b = positions.get(ids[j]);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist < minSeparation && dist > 0.001) {
          // Push apart along the line connecting them
          const push = (minSeparation - dist) / 2;
          const ux = dx / dist;
          const uy = dy / dist;
          a.x -= ux * push;
          a.y -= uy * push;
          b.x += ux * push;
          b.y += uy * push;
          moved = true;
        } else if (dist <= 0.001) {
          // Coincident nodes: push apart in DETERMINISTIC direction.
          // Math.random() made layout non-deterministic (CH: 1-7 crossings across runs).
          // Fixed angle 0 (horizontal) ensures same input → same output.
          const angle = 0;
          const push = minSeparation / 2;
          a.x -= Math.cos(angle) * push;
          a.y -= Math.sin(angle) * push;
          b.x += Math.cos(angle) * push;
          b.y += Math.sin(angle) * push;
          moved = true;
        }
      }
    }
    if (!moved) break; // All separated
  }
  
  // Phase 2: Crossing reduction — try nudges to reduce crossings
  // Try small nudges in 8 directions for each endpoint of crossing edges
  // Use multiple nudge distances: try small first, then larger if needed
  // Also try "flip" moves: mirror shared vertices across anchor to opposite side
  // (Aaron's insight: Matt on left of anchor eliminates crossings)
  const nudgeDists = [minSeparation * 0.2, minSeparation * 0.4, minSeparation * 0.6];
  const directions = [
    { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
    { dx: 0.707, dy: 0.707 }, { dx: -0.707, dy: 0.707 },
    { dx: 0.707, dy: -0.707 }, { dx: -0.707, dy: -0.707 },
  ];
  
  let currentCrossings = countCrossings(positions, links);
  
  // Phase 2a: Try "side flip" moves for nodes — move to opposite side of anchor
  // This helps shared vertices that are stranded on the wrong side
  // e.g., Matt between BBRU (right) and Ka-Chunk (left) should be on left
  // Instead of mirroring (too aggressive), try positions on opposite side at various distances
  const anchorId = ids[0]; // First node is anchor (placed at 0,0 initially)
  const anchorPos = positions.get(anchorId);
  const anchorX = anchorPos ? anchorPos.x : 0;
  const anchorY = anchorPos ? anchorPos.y : 0;
  for (const id of ids) {
    if (id === anchorId) continue;
    const pos = positions.get(id);
    if (!pos) continue;
    const origX = pos.x;
    const origY = pos.y;
    // Vector from anchor to node
    const dx = origX - anchorX;
    const dy = origY - anchorY;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) continue;
    // Try positions on opposite side: rotate 180° around anchor, at same distance
    // Also try 90° rotations and different distances
    const candidates = [];
    // Opposite side, same distance
    candidates.push({ x: anchorX - dx, y: anchorY - dy });
    // Opposite side, 0.7x distance (closer to anchor)
    candidates.push({ x: anchorX - dx * 0.7, y: anchorY - dy * 0.7 });
    // Opposite side, 1.3x distance (farther from anchor)
    candidates.push({ x: anchorX - dx * 1.3, y: anchorY - dy * 1.3 });
    // Perpendicular positions (90° rotation)
    candidates.push({ x: anchorX - dy, y: anchorY + dx });
    candidates.push({ x: anchorX + dy, y: anchorY - dx });
    
    let bestCrossings = currentCrossings;
    let bestPos = null;
    for (const cand of candidates) {
      pos.x = cand.x;
      pos.y = cand.y;
      // Check separation — allow more violation here, Phase 3 will fix it
      // We prioritize crossing reduction over strict separation in this phase
      let valid = true;
      for (const otherId of ids) {
        if (otherId === id) continue;
        const other = positions.get(otherId);
        const d = Math.hypot(pos.x - other.x, pos.y - other.y);
        if (d < minSeparation * 0.5) { // Allow up to 50% violation for crossing fix
          valid = false;
          break;
        }
      }
      if (valid) {
        const newCrossings = countCrossings(positions, links);
        if (newCrossings < bestCrossings) {
          bestCrossings = newCrossings;
          bestPos = { x: cand.x, y: cand.y };
        }
      }
    }
    if (bestPos) {
      pos.x = bestPos.x;
      pos.y = bestPos.y;
      currentCrossings = bestCrossings;
    } else {
      // Revert
      pos.x = origX;
      pos.y = origY;
    }
  }
  
  // Phase 2b: Coordinated pair moves — try moving two nodes together
  // Aaron's insight: Matt left + Shane up together = 0 crossings
  // Single-node moves can't find this because moving Matt alone violates separation
  // or moving Shane alone doesn't help. Together, they make room for each other.
  if (currentCrossings > 0) {
    for (let i = 0; i < ids.length && currentCrossings > 0; i++) {
      for (let j = i + 1; j < ids.length && currentCrossings > 0; j++) {
        const id1 = ids[i];
        const id2 = ids[j];
        if (id1 === anchorId || id2 === anchorId) continue;
        const pos1 = positions.get(id1);
        const pos2 = positions.get(id2);
        if (!pos1 || !pos2) continue;
        const orig1X = pos1.x, orig1Y = pos1.y;
        const orig2X = pos2.x, orig2Y = pos2.y;
        
        // Try: move id1 to opposite side, move id2 up (north) by minSeparation
        // This is the Matt-left + Shane-up pattern
        const dx1 = orig1X - anchorX;
        const dy1 = orig1Y - anchorY;
        const candidates1 = [
          { x: anchorX - dx1, y: anchorY - dy1 }, // Opposite side
          { x: anchorX - dx1 * 0.7, y: anchorY - dy1 * 0.7 },
        ];
        const upMoves = [
          { dx: 0, dy: -minSeparation * 0.5 },
          { dx: 0, dy: -minSeparation },
          { dx: 0, dy: minSeparation * 0.5 },
          { dx: 0, dy: minSeparation },
        ];
        
        let bestPairCrossings = currentCrossings;
        let bestPair = null;
        for (const c1 of candidates1) {
          for (const up of upMoves) {
            pos1.x = c1.x;
            pos1.y = c1.y;
            pos2.x = orig2X + up.dx;
            pos2.y = orig2Y + up.dy;
            // Check separation for both nodes (allow 50% violation)
            let valid = true;
            for (const otherId of ids) {
              if (otherId === id1 || otherId === id2) continue;
              const other = positions.get(otherId);
              const d1 = Math.hypot(pos1.x - other.x, pos1.y - other.y);
              const d2 = Math.hypot(pos2.x - other.x, pos2.y - other.y);
              if (d1 < minSeparation * 0.5 || d2 < minSeparation * 0.5) {
                valid = false;
                break;
              }
            }
            // Also check distance between the pair
            const pairDist = Math.hypot(pos1.x - pos2.x, pos1.y - pos2.y);
            if (pairDist < minSeparation * 0.5) valid = false;
            
            if (valid) {
              const newCrossings = countCrossings(positions, links);
              if (newCrossings < bestPairCrossings) {
                bestPairCrossings = newCrossings;
                bestPair = { x1: c1.x, y1: c1.y, x2: orig2X + up.dx, y2: orig2Y + up.dy };
              }
            }
          }
        }
        if (bestPair) {
          pos1.x = bestPair.x1;
          pos1.y = bestPair.y1;
          pos2.x = bestPair.x2;
          pos2.y = bestPair.y2;
          currentCrossings = bestPairCrossings;
        } else {
          pos1.x = orig1X;
          pos1.y = orig1Y;
          pos2.x = orig2X;
          pos2.y = orig2Y;
        }
      }
    }
  }
  
  for (let iter = 0; iter < 50 && currentCrossings > 0; iter++) {
    let improved = false;
    // Try nudging each node
    for (const id of ids) {
      const pos = positions.get(id);
      const origX = pos.x;
      const origY = pos.y;
      
      // Try each nudge distance
      for (const nudgeDist of nudgeDists) {
        for (const dir of directions) {
          pos.x = origX + dir.dx * nudgeDist;
          pos.y = origY + dir.dy * nudgeDist;
          
          // Check if this nudge is valid (no separation violation)
          let valid = true;
          for (const otherId of ids) {
            if (otherId === id) continue;
            const other = positions.get(otherId);
            const d = Math.hypot(pos.x - other.x, pos.y - other.y);
            if (d < minSeparation * 0.9) { // Stricter: allow only 10% violation during crossing fix
              valid = false;
              break;
            }
          }
          
          if (valid) {
            const newCrossings = countCrossings(positions, links);
            if (newCrossings < currentCrossings) {
              currentCrossings = newCrossings;
              improved = true;
              break; // Keep this nudge, move to next node
            }
          }
          
          // Revert
          pos.x = origX;
          pos.y = origY;
        }
        if (improved) break; // Found good nudge at this distance
      }
      if (improved) break; // Restart from top after improvement
    }
    
    if (!improved) break; // No improvement found
  }
  
  // Phase 3: Final separation pass — ensure min distance after crossing fixes
  // FIX 2: Balance separation vs crossings with a combined score.
  // Previously: revert if crossings increase (prioritize crossings over separation).
  // This left severe separation violations (e.g., Krist/Dave at 15.9 vs target 30).
  //
  // New logic: Use a weighted score that balances both.
  // Score = crossings * 100 + (separation violations * 50) + (total violation distance)
  // Accept a move if it reduces total score, even if crossings increase by 1
  // but violations decrease significantly.
  // A severe violation (< 0.6 * minSeparation) is worth +1 crossing to fix.
  let finalCrossings = countCrossings(positions, links);
  
  // Helper: count separation violations and total violation distance
  function separationStats(positions, minSep) {
    let violations = 0;
    let totalViolation = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = positions.get(ids[i]);
        const b = positions.get(ids[j]);
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        if (d < minSep) {
          violations++;
          totalViolation += (minSep - d);
        }
      }
    }
    return { violations, totalViolation };
  }
  
  function combinedScore(crossings, stats) {
    // Crossings weighted at 300 — best tradeoff found.
    // Weight 100: Nirvana 2 crossings, 16.5 minDist, 1 violation
    // Weight 300: Nirvana 2 crossings, 25.2 minDist, 2 violations (BEST)
    // Weight 1000: Nirvana 4 crossings, 9.6 minDist, 4 violations (WORST - too conservative)
    // Weight 300 gives best separation while keeping crossings at 2.
    return crossings * 300 + stats.violations * 50 + stats.totalViolation;
  }
  
  let currentStats = separationStats(positions, minSeparation);
  let currentScore = combinedScore(finalCrossings, currentStats);
  
  for (let iter = 0; iter < 100; iter++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = positions.get(ids[i]);
        const b = positions.get(ids[j]);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist < minSeparation && dist > 0.001) {
          // Try pushing apart
          const push = (minSeparation - dist) / 2;
          const ux = dx / dist;
          const uy = dy / dist;
          const origAx = a.x, origAy = a.y, origBx = b.x, origBy = b.y;
          a.x -= ux * push;
          a.y -= uy * push;
          b.x += ux * push;
          b.y += uy * push;
          const newCrossings = countCrossings(positions, links);
          const newStats = separationStats(positions, minSeparation);
          const newScore = combinedScore(newCrossings, newStats);
          
          if (newScore < currentScore) {
            // Accept: total score improved (even if crossings increased by 1)
            finalCrossings = newCrossings;
            currentStats = newStats;
            currentScore = newScore;
            moved = true;
          } else {
            // Revert: this push made overall score worse
            a.x = origAx; a.y = origAy;
            b.x = origBx; b.y = origBy;
          }
        }
      }
    }
    if (!moved) break;
  }
  
  // Phase 4: Final crossing reduction — after separation pass
  // Separation may have introduced new crossings. Run a final crossing-reduction
  // pass to clean them up, but only accept moves that don't violate separation
  // by more than 10% (to avoid undoing the separation work).
  let phase4Crossings = countCrossings(positions, links);
  for (let iter = 0; iter < 30 && phase4Crossings > 0; iter++) {
    let improved = false;
    for (const id of ids) {
      const pos = positions.get(id);
      const origX = pos.x;
      const origY = pos.y;
      for (const nudgeDist of [minSeparation * 0.2, minSeparation * 0.4]) {
        for (const dir of [
          { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
          { dx: 0.707, dy: 0.707 }, { dx: -0.707, dy: 0.707 },
          { dx: 0.707, dy: -0.707 }, { dx: -0.707, dy: -0.707 },
        ]) {
          pos.x = origX + dir.dx * nudgeDist;
          pos.y = origY + dir.dy * nudgeDist;
          // Check separation (allow 10% violation)
          let valid = true;
          for (const otherId of ids) {
            if (otherId === id) continue;
            const other = positions.get(otherId);
            const d = Math.hypot(pos.x - other.x, pos.y - other.y);
            if (d < minSeparation * 0.9) {
              valid = false;
              break;
            }
          }
          if (valid) {
            const newCrossings = countCrossings(positions, links);
            if (newCrossings < phase4Crossings) {
              phase4Crossings = newCrossings;
              improved = true;
              break;
            }
          }
          pos.x = origX;
          pos.y = origY;
        }
        if (improved) break;
      }
      if (improved) break;
    }
    if (!improved) break;
  }

  // Phase 5: Exhaustive grid search for nodes stuck in remaining crossings
  // OR separation violations. Phases 1-4 are greedy/local and can get stuck
  // in local minima. If crossings remain OR nodes are closer than minSeparation
  // (which would trigger the collision pass and risk new crossings),
  // grid-search each involved node's position space.
  // (Proven: Home 2° has a valid 0-crossing position at Matt=(160,0) that
  // greedy never finds. Aaron's manual drags confirm zero is achievable.)
  let phase5Crossings = countCrossings(positions, links);
  // Check separation violations too
  let minDist5 = Infinity;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = positions.get(ids[i]), b = positions.get(ids[j]);
      minDist5 = Math.min(minDist5, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  if (phase5Crossings > 0 || minDist5 < minSeparation) {
    // Find nodes involved in crossings OR separation violations
    const involved = new Set();
    const si = (p1, p2, p3, p4) => {
      const d = (p4.y - p3.y) * (p2.x - p1.x) - (p4.x - p3.x) * (p2.y - p1.y);
      if (Math.abs(d) < 1e-9) return false;
      const ua = ((p4.x - p3.x) * (p1.y - p3.y) - (p4.y - p3.y) * (p1.x - p3.x)) / d;
      const ub = ((p2.x - p1.x) * (p1.y - p3.y) - (p2.y - p1.y) * (p1.x - p3.x)) / d;
      return ua > 0.01 && ua < 0.99 && ub > 0.01 && ub < 0.99;
    };
    for (let i = 0; i < links.length; i++) {
      for (let j = i + 1; j < links.length; j++) {
        const l1 = links[i], l2 = links[j];
        const a1 = typeof l1.source === 'object' ? l1.source.id : l1.source;
        const b1 = typeof l1.target === 'object' ? l1.target.id : l1.target;
        const a2 = typeof l2.source === 'object' ? l2.source.id : l2.source;
        const b2 = typeof l2.target === 'object' ? l2.target.id : l2.target;
        if (a1 === a2 || a1 === b2 || b1 === a2 || b1 === b2) continue;
        const p1 = positions.get(a1), p2 = positions.get(b1);
        const p3 = positions.get(a2), p4 = positions.get(b2);
        if (p1 && p2 && p3 && p4 && si(p1, p2, p3, p4)) {
          involved.add(a1); involved.add(b1); involved.add(a2); involved.add(b2);
        }
      }
    }
    // Also add nodes in separation violation
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = positions.get(ids[i]), b = positions.get(ids[j]);
        if (Math.hypot(a.x - b.x, a.y - b.y) < minSeparation) {
          involved.add(ids[i]); involved.add(ids[j]);
        }
      }
    }
    // Only move non-anchor person nodes (bands and anchor stay fixed)
    // Note: nodeMap not in scope here; use positions order — anchor is ids[0]
    const anchorId5 = ids[0];
    // We need node types; reconstruct from links: bands appear as polygon centers.
    // Simpler: skip ids[0] (anchor) and try others; bands will naturally be
    // rejected if moving them doesn't help (their edges are structural).
    // To be safe, only try person nodes: detect via links (persons have degree
    // patterns, but we can't know type here). Instead, try all non-anchor and
    // let the crossing count decide.
    const candidates = [...involved].filter(id => id !== anchorId5).sort();
    // Bounding box of current layout, expanded
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const id of ids) {
      const p = positions.get(id);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const pad = minSeparation * 2;
    minX -= pad; maxX += pad; minY -= pad; maxY += pad;
    const step = minSeparation * 0.7; // ~98px grid
    // Combined score: crossings dominate, but separation violations count too.
    // This lets Phase 5 fix separation (to make collision a no-op) without
    // introducing crossings.
    const scoreOf = () => {
      const c = countCrossings(positions, links);
      let v = 0;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = positions.get(ids[i]), b = positions.get(ids[j]);
          if (Math.hypot(a.x - b.x, a.y - b.y) < minSeparation) v++;
        }
      }
      return c * 1000 + v;
    };
    // Iterate until convergence: fixing one crossing may create another.
    // Recompute involved set each iteration to catch new crossings.
    for (let p5iter = 0; p5iter < 5; p5iter++) {
      const iterScore = scoreOf();
      if (iterScore === 0) break;
      let iterImproved = false;
      // Recompute involved for this iteration
      const involvedIter = new Set();
      for (let i = 0; i < links.length; i++) {
        for (let j = i + 1; j < links.length; j++) {
          const l1 = links[i], l2 = links[j];
          const a1 = typeof l1.source === 'object' ? l1.source.id : l1.source;
          const b1 = typeof l1.target === 'object' ? l1.target.id : l1.target;
          const a2 = typeof l2.source === 'object' ? l2.source.id : l2.source;
          const b2 = typeof l2.target === 'object' ? l2.target.id : l2.target;
          if (a1 === a2 || a1 === b2 || b1 === a2 || b1 === b2) continue;
          const p1 = positions.get(a1), p2 = positions.get(b1);
          const p3 = positions.get(a2), p4 = positions.get(b2);
          if (p1 && p2 && p3 && p4 && si(p1, p2, p3, p4)) {
            involvedIter.add(a1); involvedIter.add(b1); involvedIter.add(a2); involvedIter.add(b2);
          }
        }
      }
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = positions.get(ids[i]), b = positions.get(ids[j]);
          if (Math.hypot(a.x - b.x, a.y - b.y) < minSeparation) {
            involvedIter.add(ids[i]); involvedIter.add(ids[j]);
          }
        }
      }
      const candidatesIter = [...involvedIter].filter(id => id !== anchorId5).sort();
      for (const id of candidatesIter) {
        const pos = positions.get(id);
        const origX = pos.x, origY = pos.y;
        let bestX = origX, bestY = origY, bestS = scoreOf();
        if (bestS === 0) continue;
        for (let gx = minX; gx <= maxX; gx += step) {
          for (let gy = minY; gy <= maxY; gy += step) {
            pos.x = gx; pos.y = gy;
            const s = scoreOf();
            if (s < bestS) {
              bestS = s; bestX = gx; bestY = gy;
              if (s === 0) break;
            }
          }
          if (bestS === 0) break;
        }
        if (bestX !== origX || bestY !== origY) iterImproved = true;
        pos.x = bestX; pos.y = bestY;
      }
      phase5Crossings = countCrossings(positions, links);
      if (!iterImproved) break;
    }
  }
}
