#!/usr/bin/env node
/**
 * routing.js
 * ------------------------------------------------------------------
 * Kolkata bus routing engine.
 *
 * Graph model
 *   - Nodes  : bus stops (STOP000001 ... )
 *   - Edges  : one directed edge per (fromStop -> toStop) pair that a bus
 *              actually travels, tagged with the bus number that creates it.
 *              The same physical pair of stops can have several edges if
 *              more than one bus links them.
 *
 * Search state
 *   A plain "shortest path over stops" graph search is not enough, because
 *   the thing we actually want to minimize first is BUS CHANGES, not hops.
 *   Two different edges leaving the same stop can belong to the same bus
 *   (free to take, no change) or a different bus (costs one change), so the
 *   cost of an edge depends on which bus you arrived on. That means the
 *   search space is not "stops" but:
 *
 *          state = (current_stop_id, current_bus)
 *
 *   where `current_bus` is the bus you are currently riding (or null before
 *   boarding anything).
 *
 * Cost model (lexicographic, cheapest first)
 *   1) transfers  -> number of bus changes so far (boarding the very first
 *                    bus is NOT a transfer)
 *   2) stops      -> total number of stops travelled so far
 *
 *   Every edge costs +1 stop always. It costs +1 transfer only if the bus
 *   used for that edge differs from the bus of the current state (and the
 *   current state is not "not yet boarded").
 *
 * Algorithm
 *   Dijkstra over the (stop, bus) state graph, ordered by the tuple
 *   (transfers, stops) using a binary min-heap. Because edge weights only
 *   take the values (0,1) [continue on same bus] or (1,1) [change bus],
 *   this is equivalent to a 0-1 BFS on the "transfers" dimension with the
 *   "stops" dimension used to break ties -- a plain Dijkstra with tuple
 *   comparison implements exactly that ordering and is what's used below.
 *
 *   Because Dijkstra always pops the cheapest not-yet-settled state, the
 *   first time we pop a state whose stop == destination, that is
 *   guaranteed optimal for (transfers, stops), regardless of which bus we
 *   happen to be riding when we arrive.
 * ------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------
// Binary min-heap, ordered by a user supplied comparator.
// ---------------------------------------------------------------------
class MinHeap {
  constructor(compare) {
    this.compare = compare;
    this.data = [];
  }
  get size() { return this.data.length; }
  push(item) {
    const d = this.data;
    d.push(item);
    let i = d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.compare(d[i], d[p]) < 0) {
        [d[i], d[p]] = [d[p], d[i]];
        i = p;
      } else break;
    }
  }
  pop() {
    const d = this.data;
    if (d.length === 0) return undefined;
    const top = d[0];
    const last = d.pop();
    if (d.length > 0) {
      d[0] = last;
      let i = 0;
      const n = d.length;
      while (true) {
        let l = 2 * i + 1, r = 2 * i + 2, smallest = i;
        if (l < n && this.compare(d[l], d[smallest]) < 0) smallest = l;
        if (r < n && this.compare(d[r], d[smallest]) < 0) smallest = r;
        if (smallest === i) break;
        [d[i], d[smallest]] = [d[smallest], d[i]];
        i = smallest;
      }
    }
    return top;
  }
}

// ---------------------------------------------------------------------
// RoutingEngine
// ---------------------------------------------------------------------
class RoutingEngine {
  /**
   * @param {string} graphPath - path to graph.json (used for origin -> destination routing only)
   * @param {string} [routesNodesPath] - path to routes_nodes.json (used for bus lookup only)
   */
  constructor(graphPath, routesNodesPath) {
    const raw = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
    this.meta = raw.meta;
    this.nodes = raw.nodes;         // id -> { id, name }
    this.adjacency = raw.adjacency; // id -> [ {bus, category, from, to} ]

    // name (normalized) -> stop id, for convenient lookups by human-readable
    // stop name in addition to raw STOP ids.
    this.nameIndex = new Map();
    for (const id of Object.keys(this.nodes)) {
      const norm = this._normalize(this.nodes[id].name);
      if (!this.nameIndex.has(norm)) this.nameIndex.set(norm, id);
    }

    // routes_nodes.json: the ordered, ground-truth stop list for every bus,
    // as recorded in the source data. Used exclusively for bus lookup
    // (getBusRoute) -- never for origin -> destination routing, and never
    // traversed / reconstructed in any way.
    this.routesNodes = routesNodesPath
      ? JSON.parse(fs.readFileSync(routesNodesPath, 'utf8'))
      : [];
  }

  _normalize(s) {
    return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /**
   * Resolve a user supplied stop reference (STOP id or stop name, possibly
   * partial / case-insensitive) into a canonical stop id.
   * Throws with helpful suggestions if not found or ambiguous.
   */
  resolveStop(input) {
    if (this.nodes[input]) return input; // already a valid STOP id

    const norm = this._normalize(input);
    if (this.nameIndex.has(norm)) return this.nameIndex.get(norm);

    // fallback: substring match against all stop names
    const candidates = [];
    for (const [name, id] of this.nameIndex.entries()) {
      if (name.includes(norm) || norm.includes(name)) {
        candidates.push({ id, name: this.nodes[id].name });
      }
    }

    if (candidates.length === 1) return candidates[0].id;

    if (candidates.length === 0) {
      throw new Error(`No stop found matching "${input}".`);
    }

    const list = candidates.slice(0, 10).map(c => `  - ${c.name} (${c.id})`).join('\n');
    throw new Error(
      `"${input}" is ambiguous, matched ${candidates.length} stops. Did you mean:\n${list}` +
      (candidates.length > 10 ? '\n  ...' : '')
    );
  }

  stopName(id) {
    return this.nodes[id] ? this.nodes[id].name : id;
  }

  /**
   * Core search: Dijkstra over (stop, bus) states, cost = (transfers, stops).
   *
   * @param {string} startId
   * @param {string} endId
   * @returns {object|null} result object, or null if unreachable
   */
  findPath(startId, endId) {
    if (!this.nodes[startId]) throw new Error(`Unknown start stop id: ${startId}`);
    if (!this.nodes[endId]) throw new Error(`Unknown end stop id: ${endId}`);

    if (startId === endId) {
      return this._buildResult([{ stop: startId, bus: null }]);
    }

    // state key: `${stopId}|${bus === null ? '' : bus}`
    const key = (stop, bus) => `${stop}|${bus === null ? '' : bus}`;

    const best = new Map(); // key -> [transfers, stops]
    const cameFrom = new Map(); // key -> { prevKey, viaBus, viaStop }

    const compare = (a, b) => {
      if (a.transfers !== b.transfers) return a.transfers - b.transfers;
      if (a.stops !== b.stops) return a.stops - b.stops;
      return 0;
    };

    const heap = new MinHeap(compare);

    const startKey = key(startId, null);
    best.set(startKey, [0, 0]);
    heap.push({ stop: startId, bus: null, transfers: 0, stops: 0 });

    let goalState = null;

    while (heap.size > 0) {
      const cur = heap.pop();
      const curKey = key(cur.stop, cur.bus);
      const recorded = best.get(curKey);
      // stale heap entry check
      if (!recorded || recorded[0] !== cur.transfers || recorded[1] !== cur.stops) continue;

      if (cur.stop === endId) {
        goalState = cur;
        break; // Dijkstra: first pop of the destination is optimal
      }

      const edges = this.adjacency[cur.stop] || [];
      for (const e of edges) {
        const isFirstBoarding = cur.bus === null;
        const isSameBus = !isFirstBoarding && e.bus === cur.bus;
        const transferDelta = isSameBus ? 0 : 1;
        // Boarding the very first bus of the whole journey is not a "change".
        const actualTransferDelta = isFirstBoarding ? 0 : transferDelta;

        const newTransfers = cur.transfers + actualTransferDelta;
        const newStops = cur.stops + 1;
        const newKey = key(e.to, e.bus);
        const existing = best.get(newKey);

        const better = !existing ||
          newTransfers < existing[0] ||
          (newTransfers === existing[0] && newStops < existing[1]);

        if (better) {
          best.set(newKey, [newTransfers, newStops]);
          cameFrom.set(newKey, { prevKey: curKey, viaBus: e.bus, viaStop: e.to, fromStop: cur.stop });
          heap.push({ stop: e.to, bus: e.bus, transfers: newTransfers, stops: newStops });
        }
      }
    }

    if (!goalState) return null; // unreachable

    // ---- reconstruct path of (stop, bus) states from goalState back to start
    const chain = [];
    let curKey = key(goalState.stop, goalState.bus);
    chain.push({ stop: goalState.stop, bus: goalState.bus });

    while (curKey !== startKey) {
      const step = cameFrom.get(curKey);
      if (!step) break; // safety guard, should not happen
      chain.push({ stop: step.fromStop, bus: null }); // bus filled below on second pass
      curKey = step.prevKey;
    }
    chain.reverse();

    // The reversed chain currently has stop ids correct, but the "bus used to
    // arrive at this stop" needs to be re-derived per step from cameFrom.
    // Rebuild cleanly by walking cameFrom forward using recorded viaBus values.
    const orderedKeys = [];
    curKey = key(goalState.stop, goalState.bus);
    orderedKeys.push(curKey);
    while (curKey !== startKey) {
      const step = cameFrom.get(curKey);
      curKey = step.prevKey;
      orderedKeys.push(curKey);
    }
    orderedKeys.reverse();

    const path = orderedKeys.map(k => {
      const idx = k.lastIndexOf('|');
      const stop = k.slice(0, idx);
      const busPart = k.slice(idx + 1);
      return { stop, bus: busPart === '' ? null : busPart };
    });

    return this._buildResult(path);
  }

  /**
   * Look up the display category (e.g. "Private Bus", "DN Series") for a
   * given bus number, using any edge leaving `fromStop` on that bus as a
   * representative sample (category is a property of the bus/route, not
   * of a specific edge).
   */
  _categoryFor(fromStop, bus) {
    const edges = this.adjacency[fromStop] || [];
    const match = edges.find(e => e.bus === bus);
    return match ? match.category : null;
  }

  /**
   * All distinct bus numbers present in routes_nodes.json, sorted naturally
   * (so "2" < "12" < "35C" rather than lexicographically).
   */
  listBuses() {
    if (this._busListCache) return this._busListCache;
    const set = new Set();
    for (const route of this.routesNodes) set.add(route.busNo);
    this._busListCache = Array.from(set).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    );
    return this._busListCache;
  }

  /**
   * Resolve a user supplied bus number (case-insensitive, possibly partial)
   * into a canonical bus number as it appears in routes_nodes.json.
   */
  resolveBus(input) {
    const buses = this.listBuses();
    const q = String(input).trim();
    const qLower = q.toLowerCase();

    const exact = buses.find(b => b.toLowerCase() === qLower);
    if (exact) return exact;

    const candidates = buses.filter(b => b.toLowerCase().includes(qLower));
    if (candidates.length === 1) return candidates[0];

    if (candidates.length === 0) {
      throw new Error(`No bus found matching "${input}".`);
    }

    const list = candidates.slice(0, 10).map(b => `  - ${b}`).join('\n');
    throw new Error(
      `"${input}" is ambiguous, matched ${candidates.length} buses. Did you mean:\n${list}` +
      (candidates.length > 10 ? '\n  ...' : '')
    );
  }

  /**
   * Look up a bus's stop-by-stop route.
   *
   * This is a pure lookup against routes_nodes.json -- the ordered `nodes`
   * array is returned exactly as stored, in its original recorded order.
   * There is no graph traversal or reconstruction involved, so branches,
   * loops, or stops shared with other buses (e.g. bus 215A) can never
   * scramble the order.
   *
   * @param {string} busInput - bus number, case-insensitive / partial
   * @returns {{bus:string, category:string|null, stopCount:number, nodes:string[]}}
   */
  getBusRoute(busInput) {
    const bus = this.resolveBus(busInput);

    const record = this.routesNodes.find(r => r.busNo === bus);
    if (!record) {
      throw new Error(`Bus "${bus}" has no route data in routes_nodes.json.`);
    }

    return {
      bus: record.busNo,
      category: record.category || null,
      stopCount: record.nodes.length,
      nodes: record.nodes.slice(),
    };
  }

  /**
   * Turn a raw list of {stop, bus} states (bus = the bus used to ARRIVE at
   * that stop, null for the origin) into the full structured result.
   */
  _buildResult(path) {
    const stopSequence = path.map(p => p.stop);
    const totalStops = stopSequence.length - 1; // edges travelled

    // Group consecutive states by the bus used to arrive, to build legs.
    const legs = [];
    let i = 1;
    while (i < path.length) {
      const bus = path[i].bus;
      const legStops = [path[i - 1].stop];
      while (i < path.length && path[i].bus === bus) {
        legStops.push(path[i].stop);
        i++;
      }
      legs.push({
        bus,
        category: this._categoryFor(legStops[0], bus),
        boardAt: legStops[0],
        alightAt: legStops[legStops.length - 1],
        stops: legStops, // ids, includes board + alight
        stopsTravelled: legStops.length - 1,
      });
    }

    const transfers = Math.max(legs.length - 1, 0);
    const interchangeStops = legs.slice(0, -1).map(l => l.alightAt);

    return {
      originId: stopSequence[0],
      destinationId: stopSequence[stopSequence.length - 1],
      transfers,
      totalStops,
      busesToBoard: legs.map(l => l.bus),
      interchangeStops,
      legs,
      stopSequence,
    };
  }

  /**
   * Cost tuple (transfers, stops) for a path expressed as the
   * [{stop,bus}, ...] array used internally (bus = bus used to ARRIVE
   * at that stop; path[0].bus is always null).
   */
  _pathCost(path) {
    let transfers = 0;
    for (let i = 2; i < path.length; i++) {
      if (path[i].bus !== path[i - 1].bus) transfers++;
    }
    return { transfers, stops: path.length - 1 };
  }

  static _pathKey(path) {
    return path.map(p => `${p.stop}:${p.bus || ''}`).join('>');
  }

  /**
   * Same core Dijkstra as findPath, but:
   *   - can start already "riding" a bus (startBus, used by findKPaths to
   *     resume a spur search from partway through a previously found path)
   *   - can ban specific edges (Set of "fromStop|bus|toStop" strings)
   *   - can ban visiting certain stops entirely (Set of stop ids), used to
   *     keep spur paths loopless with respect to their root path
   */
  _dijkstraConstrained(startId, endId, startBus, bannedEdgeKeys, bannedNodes) {
    const key = (stop, bus) => `${stop}|${bus === null ? '' : bus}`;
    const best = new Map();
    const cameFrom = new Map();

    const compare = (a, b) => {
      if (a.transfers !== b.transfers) return a.transfers - b.transfers;
      if (a.stops !== b.stops) return a.stops - b.stops;
      return 0;
    };
    const heap = new MinHeap(compare);

    const startKey = key(startId, startBus);
    best.set(startKey, [0, 0]);
    heap.push({ stop: startId, bus: startBus, transfers: 0, stops: 0 });

    let goalState = null;

    while (heap.size > 0) {
      const cur = heap.pop();
      const curKey = key(cur.stop, cur.bus);
      const recorded = best.get(curKey);
      if (!recorded || recorded[0] !== cur.transfers || recorded[1] !== cur.stops) continue;

      if (cur.stop === endId) { goalState = cur; break; }

      const edges = this.adjacency[cur.stop] || [];
      for (const e of edges) {
        if (bannedNodes && bannedNodes.has(e.to) && e.to !== endId) continue;
        if (bannedEdgeKeys && bannedEdgeKeys.has(`${cur.stop}|${e.bus}|${e.to}`)) continue;

        const isFirstBoarding = cur.bus === null;
        const isSameBus = !isFirstBoarding && e.bus === cur.bus;
        const actualTransferDelta = isFirstBoarding ? 0 : (isSameBus ? 0 : 1);

        const newTransfers = cur.transfers + actualTransferDelta;
        const newStops = cur.stops + 1;
        const newKey = key(e.to, e.bus);
        const existing = best.get(newKey);

        const better = !existing ||
          newTransfers < existing[0] ||
          (newTransfers === existing[0] && newStops < existing[1]);

        if (better) {
          best.set(newKey, [newTransfers, newStops]);
          cameFrom.set(newKey, { prevKey: curKey, fromStop: cur.stop });
          heap.push({ stop: e.to, bus: e.bus, transfers: newTransfers, stops: newStops });
        }
      }
    }

    if (!goalState) return null;

    const orderedKeys = [];
    let curKey = key(goalState.stop, goalState.bus);
    orderedKeys.push(curKey);
    while (curKey !== startKey) {
      const step = cameFrom.get(curKey);
      if (!step) break;
      curKey = step.prevKey;
      orderedKeys.push(curKey);
    }
    orderedKeys.reverse();

    return orderedKeys.map(k => {
      const idx = k.lastIndexOf('|');
      const stop = k.slice(0, idx);
      const busPart = k.slice(idx + 1);
      return { stop, bus: busPart === '' ? null : busPart };
    });
  }

  /**
   * Yen's algorithm for up to K loopless alternative routes, ranked by the
   * same (transfers, stops) lexicographic cost used for the single best
   * route. Returns an array of raw path arrays ([{stop,bus}, ...]),
   * cheapest first, deduplicated.
   */
  findKPaths(startId, endId, K = 4) {
    const first = this._dijkstraConstrained(startId, endId, null, null, null);
    if (!first) return [];

    const A = [first];
    const seen = new Set([RoutingEngine._pathKey(first)]);
    let B = []; // candidates: {key, path, cost}

    for (let k = 1; k < K; k++) {
      const prevPath = A[k - 1];

      for (let i = 0; i < prevPath.length - 1; i++) {
        const spurNode = prevPath[i].stop;
        const spurBus = i === 0 ? null : prevPath[i].bus;
        const rootPrefixKey = prevPath.slice(0, i + 1).map(p => `${p.stop}:${p.bus || ''}`).join('>');

        const bannedEdgeKeys = new Set();
        for (const p of A) {
          if (p.length <= i + 1) continue;
          const pPrefixKey = p.slice(0, i + 1).map(x => `${x.stop}:${x.bus || ''}`).join('>');
          if (pPrefixKey === rootPrefixKey) {
            bannedEdgeKeys.add(`${p[i].stop}|${p[i + 1].bus}|${p[i + 1].stop}`);
          }
        }
        const bannedNodes = new Set(prevPath.slice(0, i).map(p => p.stop));

        const spurPath = this._dijkstraConstrained(spurNode, endId, spurBus, bannedEdgeKeys, bannedNodes);
        if (!spurPath) continue;

        const totalPath = prevPath.slice(0, i).concat(spurPath);
        const pKey = RoutingEngine._pathKey(totalPath);
        if (seen.has(pKey) || B.some(b => b.key === pKey)) continue;

        B.push({ key: pKey, path: totalPath, cost: this._pathCost(totalPath) });
      }

      if (B.length === 0) break;

      B.sort((a, b) => {
        if (a.cost.transfers !== b.cost.transfers) return a.cost.transfers - b.cost.transfers;
        return a.cost.stops - b.cost.stops;
      });

      const chosen = B.shift();
      A.push(chosen.path);
      seen.add(chosen.key);
      B = B.filter(b => b.key !== chosen.key);
    }

    return A;
  }

  /**
   * Human-readable version of findKPaths: accepts stop names/ids, returns
   * up to K fully-resolved route objects (same shape as route()'s success
   * case), cheapest/fewest-changes first.
   */
  routeMultiple(originInput, destinationInput, K = 4) {
    const originId = this.resolveStop(originInput);
    const destinationId = this.resolveStop(destinationInput);
    const paths = this.findKPaths(originId, destinationId, K);

    if (paths.length === 0) {
      return {
        found: false,
        origin: this.stopName(originId),
        destination: this.stopName(destinationId),
        message: `No route found between "${this.stopName(originId)}" and "${this.stopName(destinationId)}" in the current graph.`,
      };
    }

    const options = paths.map(path => {
      const result = this._buildResult(path);
      return {
        found: true,
        origin: this.stopName(originId),
        destination: this.stopName(destinationId),
        busChanges: result.transfers,
        totalStopsTravelled: result.totalStops,
        busesToBoard: result.busesToBoard,
        interchangeStops: result.interchangeStops.map(id => this.stopName(id)),
        legs: result.legs.map(l => ({
          bus: l.bus,
          category: l.category,
          boardAt: this.stopName(l.boardAt),
          alightAt: this.stopName(l.alightAt),
          stopsTravelled: l.stopsTravelled,
          stopByStop: l.stops.map(id => this.stopName(id)),
        })),
        fullJourney: result.stopSequence.map(id => this.stopName(id)),
        raw: result,
      };
    });

    return { found: true, options };
  }

  /**
   * Convenience wrapper: accept stop names or ids for origin/destination,
   * run the search, and return a fully human-readable result (names
   * resolved) alongside the raw id-based result.
   */
  route(originInput, destinationInput) {
    const originId = this.resolveStop(originInput);
    const destinationId = this.resolveStop(destinationInput);
    const result = this.findPath(originId, destinationId);

    if (!result) {
      return {
        found: false,
        origin: this.stopName(originId),
        destination: this.stopName(destinationId),
        message: `No route found between "${this.stopName(originId)}" and "${this.stopName(destinationId)}" in the current graph.`,
      };
    }

    const named = {
      found: true,
      origin: this.stopName(originId),
      destination: this.stopName(destinationId),
      busChanges: result.transfers,
      totalStopsTravelled: result.totalStops,
      busesToBoard: result.busesToBoard,
      interchangeStops: result.interchangeStops.map(id => this.stopName(id)),
      legs: result.legs.map(l => ({
        bus: l.bus,
        category: l.category,
        boardAt: this.stopName(l.boardAt),
        alightAt: this.stopName(l.alightAt),
        stopsTravelled: l.stopsTravelled,
        stopByStop: l.stops.map(id => this.stopName(id)),
      })),
      fullJourney: result.stopSequence.map(id => this.stopName(id)),
      raw: result,
    };
    return named;
  }
}

// ---------------------------------------------------------------------
// Pretty printer for CLI output
// ---------------------------------------------------------------------
function printResult(res) {
  if (!res.found) {
    console.log(res.message);
    return;
  }
  console.log(`\nRoute: ${res.origin}  ->  ${res.destination}`);
  console.log('='.repeat(60));
  console.log(`Bus changes      : ${res.busChanges}`);
  console.log(`Total stops      : ${res.totalStopsTravelled}`);
  console.log(`Buses to board   : ${res.busesToBoard.join(' -> ')}`);
  console.log(`Interchange stops: ${res.interchangeStops.length ? res.interchangeStops.join(', ') : '(none, direct bus)'}`);
  console.log('-'.repeat(60));
  res.legs.forEach((leg, idx) => {
    console.log(`Leg ${idx + 1}: Bus ${leg.bus}  (${leg.boardAt} -> ${leg.alightAt}, ${leg.stopsTravelled} stops)`);
    leg.stopByStop.forEach((s, j) => {
      const marker = j === 0 ? 'board' : (j === leg.stopByStop.length - 1 ? 'alight' : '  via');
      console.log(`    [${marker}] ${s}`);
    });
  });
  console.log('-'.repeat(60));
  console.log('Full stop-by-stop journey:');
  console.log('  ' + res.fullJourney.join('  ->  '));
  console.log('='.repeat(60) + '\n');
}

// ---------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const jsonFlagIdx = args.indexOf('--json');
  const asJson = jsonFlagIdx !== -1;
  if (asJson) args.splice(jsonFlagIdx, 1);

  if (args.length < 2) {
    console.log('Usage: node routing.js "<origin stop>" "<destination stop>" [--json]');
    console.log('Example: node routing.js "Esplanade" "Garia"');
    process.exit(1);
  }

  const graphPath = path.join(__dirname, 'graph.json');
  const routesNodesPath = path.join(__dirname, 'routes_nodes.json');
  const engine = new RoutingEngine(graphPath, routesNodesPath);

  const [origin, destination] = args;

  try {
    const result = engine.route(origin, destination);
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printResult(result);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { RoutingEngine, MinHeap };