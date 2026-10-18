// Layout is derived only from recorded, accessible lineage. Names never identify branches.
function graph(rooms, links) {
  const nodes = new Map(rooms.filter(room => room && typeof room.id === 'string').map(room => [room.id, room]));
  const parents = new Map([...nodes.keys()].map(id => [id, []]));
  for (const link of links || []) {
    if (!link || !nodes.has(link.id)) continue;
    const ids = [...(Array.isArray(link.parents) ? link.parents : []), link.parent, link.mergedFrom];
    parents.set(link.id, [...new Set([...parents.get(link.id), ...ids])].filter(id => id !== link.id && nodes.has(id)));
  }
  return {nodes, parents};
}
function ancestry(id, parents) {
  const found = new Set(), pending = [id];
  while (pending.length) {
    const current = pending.pop(); if (found.has(current)) continue;
    found.add(current); pending.push(...(parents.get(current) || []));
  }
  return found;
}
export function relatedBranchIds(roomId, rooms, links) {
  const {nodes, parents} = graph(rooms, links);
  if (!nodes.has(roomId)) return [];
  const mine = ancestry(roomId, parents);
  return [...nodes.values()].filter(room => room.id !== roomId && !room.archived && [...ancestry(room.id, parents)].some(id => mine.has(id))).map(room => room.id);
}
export function layoutBranches(rooms, links, {query = '', order = []} = {}) {
  const active = rooms.filter(room => !room.archived), {nodes, parents} = graph(active, links);
  const operations = new Map((links || []).filter(Boolean).map(link => [link.id, link.operation]));
  const position = new Map(active.map((room, index) => [room.id, index]));
  const time = room => typeof room.createdAt === 'number' ? room.createdAt : Date.parse(room.createdAt) || 0;
  const compare = (a, b) => time(nodes.get(a)) - time(nodes.get(b)) || position.get(a) - position.get(b) || a.localeCompare(b);
  const pending = new Set(nodes.keys()), ordered = [], placedAt = new Map();
  const connectionRank = id => Math.max(-1, ...parents.get(id).map(parent => placedAt.get(parent) ?? -1));
  const compareReady = (a, b) => connectionRank(b) - connectionRank(a) || compare(a, b);
  while (pending.size) {
    let ready = [...pending].filter(id => parents.get(id).every(parent => !pending.has(parent))).sort(compareReady);
    if (!ready.length) {
      // A malformed cycle must not hang rendering or draw an invented connection.
      ready = [[...pending].sort(compare)[0]];
      parents.set(ready[0], parents.get(ready[0]).filter(parent => !pending.has(parent)));
    }
    const id = ready[0]; pending.delete(id); placedAt.set(id, ordered.length); ordered.push(id);
  }
  const needle = query.trim().toLocaleLowerCase();
  const matches = new Set(ordered.filter(id => !needle || [nodes.get(id).name, nodes.get(id).description].join(' ').toLocaleLowerCase().includes(needle)));
  const visible = new Set([...matches].flatMap(id => [...ancestry(id, parents)]));
  const ids = ordered.filter(id => visible.has(id));
  const children = new Map(ids.map(id => [id, []]));
  for (const id of ids) for (const parent of parents.get(id)) if (visible.has(parent)) children.get(parent).push(id);
  const remaining = new Map(ids.map(id => [id, children.get(id).length])), occupied = new Map(), placed = new Map(), rows = [];
  for (const id of ids) {
    const prior = parents.get(id).filter(parent => placed.has(parent));
    for (const parent of prior) {
      remaining.set(parent, remaining.get(parent) - 1);
      if (!remaining.get(parent)) occupied.delete(placed.get(parent).lane);
    }
    let lane = prior.length ? placed.get(prior[0]).lane : 0;
    if (occupied.has(lane)) { lane = 0; while (occupied.has(lane)) lane += 1; }
    const row = {room: nodes.get(id), id, parents: prior, children: children.get(id), lane, index: rows.length, matched: matches.has(id), operation: prior.length ? (prior.length > 1 || operations.get(id) === 'merge' ? 'merge' : 'fork') : 'root'};
    rows.push(row); placed.set(id, row);
    if (remaining.get(id)) occupied.set(lane, id);
  }
  const edges = rows.flatMap(row => row.parents.map((parent, index) => ({from: parent, to: row.id, secondary: index > 0})));
  // User placement changes display positions, never lineage or the lanes derived
  // from it. A child can appear above its parent without losing their edge.
  const ranks = new Map();
  for (const id of Array.isArray(order) ? order : []) if (typeof id === 'string' && !ranks.has(id)) ranks.set(id, ranks.size);
  const displayed = [...rows].sort((a, b) => Number(!!b.room.pinned) - Number(!!a.room.pinned) || (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity) || a.index - b.index).map((row, index) => ({...row, index}));
  return {rows: displayed, edges, laneCount: rows.length ? Math.max(...rows.map(row => row.lane)) + 1 : 0};
}

/** Keep curved branch joins away from other row nodes, including after a drag. */
export function branchGraphGeometry({rows = [], edges = [], laneCount = 0}, {rowHeight = 44, maxWidth = 72} = {}) {
  const step = 12, origin = 10;
  const nodes = rows.map(row => ({id: row.id, x: origin + row.lane * step, y: row.index * rowHeight + rowHeight / 2}));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const right = origin + Math.max(0, laneCount - 1) * step, routes = [];
  const paths = [];
  for (const edge of edges) {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    if (!from || !to) continue;
    const direction = to.y >= from.y ? 1 : -1, low = Math.min(from.y, to.y), high = Math.max(from.y, to.y);
    const verticalX = edge.secondary ? from.x : to.x;
    const blocked = nodes.some(node => node.y > low && node.y < high && node.x === verticalX);
    let d;
    if (blocked) {
      // Reuse a route once its interval ends. A long merge cannot run straight
      // through a different session's dot or acquire a dotted pseudo-branch.
      let route = routes.findIndex(intervals => intervals.every(([start, end]) => high <= start || low >= end));
      if (route < 0) { route = routes.length; routes.push([]); }
      routes[route].push([low, high]);
      const x = right + 10 + route * 8, bend = Math.min(20, (high - low) / 3);
      d = `M${from.x},${from.y}C${from.x},${from.y + bend * direction} ${x},${from.y} ${x},${from.y + bend * direction}V${to.y - bend * direction}C${x},${to.y} ${to.x},${to.y - bend * direction} ${to.x},${to.y}`;
    } else if (from.x === to.x) {
      d = `M${from.x},${from.y}V${to.y}`;
    } else {
      const bend = Math.min(22, (high - low) / 2);
      d = edge.secondary
        ? `M${from.x},${from.y}V${to.y - bend * direction}C${from.x},${to.y} ${to.x},${to.y - bend * direction} ${to.x},${to.y}`
        : `M${from.x},${from.y}C${from.x},${from.y + bend * direction} ${to.x},${from.y} ${to.x},${from.y + bend * direction}V${to.y}`;
    }
    paths.push({...edge, d});
  }
  const naturalWidth = Math.max(30, right + (routes.length ? 10 + (routes.length - 1) * 8 : 0) + 12);
  const width = Math.min(naturalWidth, Number.isFinite(maxWidth) ? Math.max(30, maxWidth) : 72);
  if (width < naturalWidth) {
    // All routes are resolved before the shared x transform, preserving the
    // avoidance decisions and endpoint alignment. Keep both rail margins fixed.
    const scale = (width - 22) / (naturalWidth - 22);
    const projectX = value => Number((origin + (value - origin) * scale).toFixed(3));
    for (const node of nodes) node.x = projectX(node.x);
    // Our path grammar uses x,y pairs plus vertical-only V coordinates. Scale
    // every pair together and leave row heights and vertical bends untouched.
    for (const path of paths) path.d = path.d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, x, y) => `${projectX(Number(x))},${y}`);
  }
  return {nodes, paths, width, height: rows.length * rowHeight};
}

/** Show lineage once in the relation label instead of repeating generated suffixes. */
export function branchDisplayName(row) {
  const name = typeof row?.room?.name === 'string' ? row.room.name : '';
  if (row?.operation !== 'fork' && row?.operation !== 'merge') return name;
  const base = name.replace(/(?: · (?:Fork|Merge))+$/, '');
  return base.trim() ? base : name;
}
