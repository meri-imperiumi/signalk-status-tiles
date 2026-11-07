signalk-plotterext-bus 0.21.0, vendored as static browser assets (no npm
dependency, no build tooling — same policy as the family's other
plugins). Fetched via `npm pack signalk-plotterext-bus@0.21.0`, dist
files only — the /extension entry (the /host side is not needed here:
this plugin only provides widgets, it is not itself a plotter host):

- extension.js (the /extension entry, re-exports the client)
- chunk-WWNNVR3K.js (ExtensionClient + connectExtension)
- chunk-WV66EF3N.js (bus protocol core: envelope, JSON-RPC, wildcard
  events)
- LICENSE (MIT, Copyright (c) 2026 Joel Kozikowski)

The client runs inside `tile-ext-widget.html` iframes on host
chartplotters (Freeboard-SK and any Plotter Extensions API v1 host),
subscribing to the plugin's published tile paths through the host's
multiplexed Signal K relay. The documented wire format is the
contract.
