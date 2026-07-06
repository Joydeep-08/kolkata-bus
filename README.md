# 🚌 Kolkata Bus Route Finder

**Find the smartest way across Kolkata's bus network — fewest changes, fewest stops, zero backend.**

The Kolkata Bus Route Finder models the entire city bus network as a graph and runs a Dijkstra-style search over it to answer one question well: *what's the best way to get from stop A to stop B?* Instead of listing every bus that technically passes near your destination, it prioritizes the journey a real commuter would actually want to take.

---

## Table of Contents

- [Why this exists](#why-this-exists)
- [Features](#features)
- [Demo](#demo)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [How Routing Works](#how-routing-works)
- [Data Format](#data-format)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Why this exists

Finding a bus in Kolkata usually means asking around, checking multiple route boards, or guessing which interchange stop won't leave you stranded. This project replaces that guesswork with a routing engine that treats the bus network like what it actually is — a graph — and optimizes for what commuters care about most:

1. ✅ **Least bus changes** — a longer ride on one bus beats three short hops
2. ✅ **Fewest stops travelled** — among equally-good options, the shorter journey wins

---

## Features

| | |
|---|---|
| 🔍 **Stop-to-stop search** | Search between any two of the network's stops |
| 🚍 **Smart prioritization** | Minimizes bus changes first, then stops travelled |
| 📍 **Full bus list** | Shows every bus number you need to board, in order |
| 🔄 **Interchange clarity** | Highlights exactly where you switch buses |
| 🛣️ **Stop-by-stop breakdown** | Full journey shown one stop at a time, per leg |
| 💡 **Autocomplete** | Fuzzy-matches stop names as you type |
| ⚡ **Instant results** | Client-side graph search — no server round-trip |
| 📱 **Responsive UI** | Works cleanly on both desktop and mobile |

---

## Demo

**Input**
```
From: Mahisbathan
To:   Howrah Station
```

**Output**
```
🚌 Board Bus 35C at Mahisbathan
↓ Philips Complex
↓ Salt Lake
🔄 Change Bus
🚌 Board Bus 71
↓ Kankurgachi
↓ Maniktala
↓ Sealdah
↓ M.G. Road
↓ Barabazar
🏁 Arrive at Howrah Station
```

Along with the summary: bus changes, total stops travelled, buses to board, and interchange stops.

---

## Tech Stack

- **HTML / CSS / Vanilla JavaScript** — no frameworks, no build step
- **Graph-based routing algorithm** — custom Dijkstra-style search (`routing.js`)
- **JSON** — network graph and stop database, loaded via `fetch()`

No backend. No database. No dependencies to install — just static files.

---

## Project Structure

```
/
│
├── index.html      # Entire UI (layout, styling, and app logic)
├── routing.js      # Routing engine (RoutingEngine class)
├── graph.json      # Bus network graph (adjacency data)
├── stops.json      # Stop database (names, IDs, route lists)
└── README.md
```

---

## Getting Started

Because `index.html` loads `stops.json`, `graph.json`, and `routing.js` via `fetch()`, browsers will block those requests over the `file://` protocol. Serve the folder through any local web server:

```bash
# Python
python3 -m http.server

# or Node
npx serve .
```

Then open:

```
http://localhost:8000
```

Type a "From" and "To" stop, pick from the autocomplete suggestions, and hit **Find my route**.

---

## How Routing Works

Most naive bus-route searches treat the network as a graph of *stops*. That falls apart the moment you need to distinguish "still on the same bus" from "just got on a new one" — which is exactly what determines whether a journey counts as direct or requires a change.

This engine instead treats every search state as a pair:

```
(current_stop, current_bus)
```

Edges between states cost `(0, 1)` when you continue on the same bus one stop further, and `(1, 0)` when you board a different bus. A Dijkstra-style search over the combined cost tuple:

```
(transfers, stops_travelled)
```

then guarantees the returned journey has, in order of priority:

1. The **minimum number of bus changes**
2. Among ties, the **minimum number of stops travelled**

The result is decomposed into legs (one per bus boarded), each carrying its boarding/alighting stop, the full stop-by-stop path, and the stop count — everything the UI needs to render the journey.

---

## Data Format

### `stops.json`

Every stop in the network, with the routes that serve it.

```json
{
  "id": "STOP001227",
  "name": "Mahisbathan",
  "routeCount": 4,
  "routes": ["201", "35C", "DN47", "KB16"]
}
```

### `graph.json`

The bus network as an adjacency structure. Each edge represents one bus travelling directly between two consecutive stops, and carries:

- Bus number
- Bus category (State / Private / Mini / Blue-Yellow / 200-Series / SD-Series / DN-Series)
- From stop
- To stop

---

## Roadmap

- 🗺️ Interactive map view of the journey
- 📍 "Nearest stop" lookup using device GPS
- 🚶 Walking directions between interchange stops
- ⏱️ Bus timing / frequency estimates
- ⭐ Multiple ranked route suggestions, not just the single best
- ❤️ Saved / favorite routes
- 📲 Installable Progressive Web App

---

## Contributing

Route and stop data inevitably drifts from reality — diversions, discontinued routes, renamed stops. If you spot something wrong in `graph.json` or `stops.json`, or want to help with an item on the roadmap, issues and pull requests are welcome.

---

## License


MIT