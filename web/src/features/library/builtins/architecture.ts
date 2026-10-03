/** Built-in pack: Architecture (link). */
import type { LibraryPack } from "../types";
import { box, item, link, text } from "./_kit";

const H = "link" as const;

function clientApiDb() {
  const c = box("rounded", 0, 8, 140, 64, "Client", H);
  const a = box("rounded", 188, 8, 140, 64, "API", H);
  const d = box("cylinder", 376, 0, 120, 80, "Database", H);
  return item(
    "ar-client-api-db",
    "Client → API → DB",
    ["request", "backend", "server", "database", "basic"],
    [c, a, d],
    [link(c, a, { from: "r", to: "l" }), link(a, d, { from: "r", to: "l" })],
  );
}

function loadBalancer() {
  const lb = box("rounded", 150, 0, 180, 56, "Load balancer", "ember");
  const s = [0, 170, 340].map((x, i) => box("rounded", x, 120, 140, 56, `Service ${i + 1}`, H));
  return item(
    "ar-load-balancer",
    "Load Balancer + 3 Services",
    ["lb", "scale", "replicas", "traffic", "horizontal"],
    [lb, ...s],
    s.map((n) => link(lb, n, { from: "b", to: "t" })),
  );
}

function queueWorker() {
  const p = box("rounded", 0, 8, 140, 64, "Producer", H);
  const q = box("queue", 188, 8, 160, 64, "Queue", H);
  const w = box("rounded", 396, 8, 140, 64, "Worker", H);
  return item(
    "ar-queue-worker",
    "Queue + Worker",
    ["async", "job", "background", "message", "broker"],
    [p, q, w],
    [link(p, q, { from: "r", to: "l", label: "enqueue" }), link(q, w, { from: "r", to: "l", label: "consume" })],
  );
}

function cacheAside() {
  const app = box("rounded", 0, 8, 140, 64, "App", H);
  const c = box("cylinder", 204, 0, 120, 80, "Cache", "ember");
  const db = box("cylinder", 204, 128, 120, 80, "Database", H);
  return item(
    "ar-cache",
    "Cache-Aside",
    ["cache", "redis", "memory", "read", "miss"],
    [app, c, db],
    [link(app, c, { from: "r", to: "l", label: "check" }), link(app, db, { from: "b", to: "l", label: "on miss" })],
  );
}

function cdn() {
  const u = box("rounded", 0, 16, 120, 64, "Users", H);
  const c = box("cloud", 168, 0, 160, 96, "CDN", H);
  const o = box("rounded", 376, 16, 140, 64, "Origin", H);
  return item(
    "ar-cdn",
    "CDN + Origin",
    ["cdn", "edge", "static", "assets", "cache"],
    [u, c, o],
    [link(u, c, { from: "r", to: "l" }), link(c, o, { from: "r", to: "l", dash: "dashed" })],
  );
}

function auth() {
  const app = box("rounded", 0, 24, 140, 64, "App", H);
  const s = box("shield", 188, 0, 112, 112, "Auth", "ember");
  const db = box("cylinder", 348, 16, 112, 80, "Users", H);
  return item(
    "ar-auth",
    "Auth Service",
    ["auth", "login", "identity", "security", "sso", "token"],
    [app, s, db],
    [link(app, s, { from: "r", to: "l", label: "token?" }), link(s, db, { from: "r", to: "l" })],
  );
}

function threeTier() {
  const a = box("rounded", 0, 0, 240, 56, "Presentation", H);
  const b = box("rounded", 0, 88, 240, 56, "Application", H);
  const c = box("cylinder", 40, 176, 160, 80, "Data", H);
  return item(
    "ar-three-tier",
    "3-Tier Stack",
    ["layers", "tiers", "n-tier", "stack", "mvc"],
    [a, b, c],
    [link(a, b, { from: "b", to: "t" }), link(b, c, { from: "b", to: "t" })],
  );
}

function microservice() {
  const frame = box("rect", 0, 0, 260, 168, "", H, { paper: true, strokeDash: "dashed" });
  const title = text(16, 8, 228, 32, "Orders service", { fontSize: 18 });
  const api = box("rounded", 24, 64, 96, 64, "API", H);
  const db = box("cylinder", 144, 56, 92, 80, "Store", H);
  return item(
    "ar-microservice",
    "Microservice",
    ["service", "bounded context", "container", "module", "domain"],
    [frame, title, api, db],
    [link(api, db, { from: "r", to: "l" })],
  );
}

function externalApi() {
  const app = box("rounded", 0, 20, 140, 64, "Our app", H);
  const ext = box("cloud", 188, 0, 200, 104, "3rd-party API", H, { strokeDash: "dashed" });
  return item(
    "ar-external-api",
    "External API",
    ["third party", "integration", "vendor", "saas", "cloud"],
    [app, ext],
    [link(app, ext, { from: "r", to: "l", label: "HTTPS", dash: "dashed" })],
  );
}

function eventBus() {
  const bus = box("rect", 0, 120, 520, 48, "Event bus", H, { solid: true });
  const p1 = box("rounded", 40, 0, 140, 56, "Orders", H);
  const p2 = box("rounded", 340, 0, 140, 56, "Billing", H);
  const s1 = box("rounded", 40, 232, 140, 56, "Email", H);
  const s2 = box("rounded", 340, 232, 140, 56, "Analytics", H);
  const L = { x: 110 / 520, y: 0 };
  const R = { x: 410 / 520, y: 0 };
  return item(
    "ar-event-bus",
    "Event Bus",
    ["pubsub", "events", "kafka", "stream", "publish", "subscribe"],
    [bus, p1, p2, s1, s2],
    [
      link(p1, bus, { from: "b", toAt: L }),
      link(p2, bus, { from: "b", toAt: R }),
      link(bus, s1, { fromAt: { x: L.x, y: 1 }, to: "t" }),
      link(bus, s2, { fromAt: { x: R.x, y: 1 }, to: "t" }),
    ],
  );
}

function component() {
  const a = box("component", 0, 0, 180, 96, "Payments", H, { fontSize: 18 });
  return item("ar-component", "Component", ["module", "uml", "library", "package", "unit"], [a]);
}

function gateway() {
  const web = box("rounded", 0, 0, 120, 56, "Web", H);
  const mob = box("rounded", 0, 88, 120, 56, "Mobile", H);
  const gw = box("hexagon", 176, 36, 160, 72, "API gateway", "ember");
  const a = box("rounded", 392, 0, 128, 56, "Users API", H);
  const b = box("rounded", 392, 88, 128, 56, "Orders API", H);
  return item(
    "ar-gateway",
    "API Gateway",
    ["gateway", "routing", "bff", "proxy", "clients"],
    [web, mob, gw, a, b],
    [
      link(web, gw, { from: "r", to: "l" }),
      link(mob, gw, { from: "r", to: "l" }),
      link(gw, a, { from: "r", to: "l" }),
      link(gw, b, { from: "r", to: "l" }),
    ],
  );
}

export const ARCHITECTURE_PACK: LibraryPack = {
  id: "architecture",
  name: "Architecture",
  blurb: "Services, data stores, queues and the arrows between them",
  hue: H,
  items: [
    clientApiDb(),
    loadBalancer(),
    queueWorker(),
    cacheAside(),
    cdn(),
    auth(),
    threeTier(),
    microservice(),
    externalApi(),
    eventBus(),
    component(),
    gateway(),
  ],
};
