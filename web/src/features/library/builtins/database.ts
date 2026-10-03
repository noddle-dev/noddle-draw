/** Built-in pack: Database / ERD (lilac). Entities = header + field list. */
import type { DiagramNode } from "../../../editor-core/diagram";
import type { LibraryPack } from "../types";
import { box, item, link } from "./_kit";

const H = "lilac" as const;
const G = { group: true };
const fieldText = { textAlign: "left" as const, bold: false, fontSize: 14, fontFamily: "mono" as const };

/** An entity table: solid header + a body listing one field per line. */
export function entity(x: number, y: number, name: string, fields: string[], w = 200): [DiagramNode, DiagramNode] {
  const head = box("rect", x, y, w, 40, name, H, { solid: true, cornerRadius: 0 });
  const bodyH = Math.ceil((fields.length * 18 + 16) / 4) * 4;
  const body = box("rect", x, y + 40, w, bodyH, fields.join("\n"), H, { ...fieldText, paper: true, cornerRadius: 0 });
  return [head, body];
}

function users() {
  const e = entity(0, 0, "users", ["id  PK", "email", "name", "created_at"]);
  return item("db-entity", "Entity Table", ["entity", "table", "erd", "schema", "columns"], e, [], G);
}

function oneToMany() {
  const [ch, cb] = entity(0, 0, "customers", ["id  PK", "name", "email"], 180);
  const [oh, ob] = entity(260, 0, "orders", ["id  PK", "customer_id  FK", "total"], 200);
  const e = {
    ...link(cb, ob, { from: "r", to: "l", head: "none" }),
    labels: [
      { id: "l1", t: 0.12, text: "1" },
      { id: "l2", t: 0.88, text: "N" },
    ],
  };
  return item("db-one-to-many", "1–N Relation", ["relation", "one to many", "foreign key", "erd", "join"], [ch, cb, oh, ob], [e]);
}

function manyToMany() {
  const [sh, sb] = entity(0, 0, "students", ["id  PK", "name"], 160);
  const [jh, jb] = entity(216, 0, "enrollments", ["student_id  FK", "course_id  FK"], 176);
  const [kh, kb] = entity(448, 0, "courses", ["id  PK", "title"], 160);
  return item(
    "db-many-to-many",
    "N–N via Join Table",
    ["many to many", "join table", "junction", "association", "erd"],
    [sh, sb, jh, jb, kh, kb],
    [link(sb, jb, { from: "r", to: "l", head: "none" }), link(jb, kb, { from: "r", to: "l", tail: "none", head: "none" })],
  );
}

function cylinder() {
  const d = box("cylinder", 0, 0, 120, 140, "orders_db", H, { fontSize: 16 });
  return item("db-cylinder", "Database", ["database", "db", "cylinder", "storage", "sql"], [d]);
}

function starSchema() {
  const [fh, fb] = entity(200, 120, "fact_sales", ["date_id", "product_id", "store_id", "amount"], 160);
  const dims = [
    box("rounded", 210, 24, 140, 48, "dim_date", H, { fontSize: 14 }),
    box("rounded", 420, 160, 140, 48, "dim_product", H, { fontSize: 14 }),
    box("rounded", 210, 312, 140, 48, "dim_store", H, { fontSize: 14 }),
    box("rounded", 0, 160, 140, 48, "dim_customer", H, { fontSize: 14 }),
  ];
  const s = { routing: "straight" as const, head: "none" as const };
  return item(
    "db-star",
    "Star Schema",
    ["star schema", "fact", "dimension", "warehouse", "olap"],
    [fh, fb, ...dims],
    [
      link(dims[0], fh, { ...s, from: "b", to: "t" }),
      link(dims[1], fb, { ...s, from: "l", to: "r" }),
      link(dims[2], fb, { ...s, from: "t", to: "b" }),
      link(dims[3], fb, { ...s, from: "r", to: "l" }),
    ],
  );
}

function kvStore() {
  const h = box("rect", 0, 0, 260, 40, "key → value", H, { solid: true, cornerRadius: 0 });
  const b = box("rect", 0, 40, 260, 76, 'session:42 → {…}\nuser:7 → "Linh"\nrate:ip → 17', H, {
    ...fieldText,
    paper: true,
    cornerRadius: 0,
  });
  return item("db-kv", "Key/Value Store", ["key value", "kv", "redis", "cache", "hash"], [h, b], [], G);
}

function docStore() {
  const d = box("multiDocument", 0, 0, 200, 132, '{\n  "id": 7,\n  "tags": ["a"]\n}', H, { ...fieldText, fontSize: 12 });
  return item("db-doc", "Document Store", ["document", "nosql", "json", "collection", "mongo"], [d]);
}

function pipeline() {
  const a = box("cylinder", 0, 0, 100, 80, "Source", H, { fontSize: 14 });
  const b = box("hexagon", 148, 8, 140, 64, "ETL", "ember");
  const c = box("cylinder", 336, 0, 120, 80, "Warehouse", H, { fontSize: 14 });
  const d = box("display", 504, 8, 140, 64, "BI", H);
  return item(
    "db-pipeline",
    "Source → ETL → Warehouse → BI",
    ["pipeline", "etl", "elt", "warehouse", "analytics", "bi"],
    [a, b, c, d],
    [link(a, b, { from: "r", to: "l" }), link(b, c, { from: "r", to: "l" }), link(c, d, { from: "r", to: "l" })],
  );
}

function replicas() {
  const p = box("cylinder", 120, 0, 120, 88, "Primary", "ember", { fontSize: 14 });
  const r1 = box("cylinder", 0, 152, 120, 88, "Replica", H, { fontSize: 14 });
  const r2 = box("cylinder", 240, 152, 120, 88, "Replica", H, { fontSize: 14 });
  return item(
    "db-replicas",
    "Primary + Replicas",
    ["replica", "replication", "read replica", "high availability", "failover"],
    [p, r1, r2],
    [link(p, r1, { dash: "dashed", label: "sync" }), link(p, r2, { dash: "dashed", label: "sync" })],
  );
}

function lake() {
  const q = box("queue", 0, 8, 140, 64, "Events", H, { fontSize: 14 });
  const j = box("rounded", 188, 8, 140, 64, "Stream job", H);
  const l = box("storedData", 376, 0, 160, 80, "Data lake", H);
  return item(
    "db-lake",
    "Stream → Data Lake",
    ["stream", "lake", "events", "ingest", "storage"],
    [q, j, l],
    [link(q, j, { from: "r", to: "l" }), link(j, l, { from: "r", to: "l" })],
  );
}

export const DATABASE_PACK: LibraryPack = {
  id: "database",
  name: "Database & ERD",
  blurb: "Entity tables, relations, schemas and data pipelines",
  hue: H,
  items: [users(), oneToMany(), manyToMany(), cylinder(), starSchema(), kvStore(), docStore(), pipeline(), replicas(), lake()],
};
