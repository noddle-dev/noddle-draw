/**
 * features/diagram/stencils/aws — AWS stencil glyphs.
 *
 * ⚠️ LICENSING: every glyph below is an ORIGINAL drawing (see icons.ts header)
 * — no official AWS Architecture Icon path data is copied or traced. They only
 * borrow the *visual language* of the AWS 2021+ architecture style (as used by
 * Lucidchart's AWS library) so a board reads at a glance:
 *   • flat square tile (radius 1), ONE flat colour per service category;
 *   • bold white glyph, ~65% of the tile, kept inside a 3.5-unit margin
 *     (path geometry ≤ 4.2..19.8 so strokes never touch the tile edge);
 *   • line weight scales with the icon (box units, not px): outlines 1.5,
 *     inner detail 1.1–1.3, plus solid white sub-shapes for legibility at 24px;
 *   • knock-outs (accent-coloured fill/stroke) separate overlapping shapes.
 */
import type { IconDef, IconPart } from "../icons";

// ---- category accents (AWS 2021+ flat palette) -----------------------------
const COMPUTE = "#ED7100"; // Compute & Containers
const STORAGE = "#7AA116";
const DATABASE = "#C925D1";
const NETWORK = "#8C4FFF"; // Networking & Content Delivery
const ANALYTICS = "#8C4FFF";
const INTEGRATION = "#E7157B"; // Application Integration
const MANAGEMENT = "#E7157B"; // Management & Governance
const SECURITY = "#DD344C"; // Security, Identity & Compliance
const FRONTEND = "#DD344C"; // Front-End Web & Mobile
const AIML = "#01A88D";

const W = "#ffffff";

// ---- tiny geometry helpers (0..24 box) -------------------------------------
const n = (v: number) => String(Math.round(v * 100) / 100);
const circle = (cx: number, cy: number, r: number) =>
  `M${n(cx - r)} ${n(cy)} a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0 a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0 Z`;
const ellipse = (cx: number, cy: number, rx: number, ry: number) =>
  `M${n(cx - rx)} ${n(cy)} a${n(rx)} ${n(ry)} 0 1 0 ${n(2 * rx)} 0 a${n(rx)} ${n(ry)} 0 1 0 ${n(-2 * rx)} 0 Z`;
const rect = (x: number, y: number, w: number, h: number, r = 0) =>
  r <= 0
    ? `M${n(x)} ${n(y)} H${n(x + w)} V${n(y + h)} H${n(x)} Z`
    : `M${n(x + r)} ${n(y)} H${n(x + w - r)} a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(r)} V${n(y + h - r)} ` +
      `a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(r)} H${n(x + r)} a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(-r)} ` +
      `V${n(y + r)} a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(-r)} Z`;

/** white stroke (default outline weight 1.5) */
const S = (d: string, sw = 1.5): IconPart => ({ d, sw });
/** solid white shape */
const F = (d: string): IconPart => ({ d, fill: W });
/** solid white shape with an accent-coloured outline (separates overlaps) */
const FK = (d: string, accent: string, sw = 1.2): IconPart => ({ d, fill: W, stroke: accent, sw });
/** accent-coloured knock-out drawn on top of a white shape */
const K = (d: string, accent: string, sw = 1.1, fill = false): IconPart =>
  fill ? { d, fill: accent } : { d, stroke: accent, sw };

/** database cylinder: outline parts + optional band arcs */
function cylinder(cx: number, top: number, rx: number, ry: number, h: number, bands: number[] = [], capFill = false): IconPart[] {
  const parts: IconPart[] = [];
  parts.push(capFill ? { d: ellipse(cx, top, rx, ry), fill: W, stroke: W, sw: 1.5 } : S(ellipse(cx, top, rx, ry)));
  parts.push(S(`M${n(cx - rx)} ${n(top)} V${n(top + h)} a${n(rx)} ${n(ry)} 0 0 0 ${n(2 * rx)} 0 V${n(top)}`));
  for (const y of bands) parts.push(S(`M${n(cx - rx)} ${n(y)} a${n(rx)} ${n(ry)} 0 0 0 ${n(2 * rx)} 0`, 1.2));
  return parts;
}

type Spec = Omit<IconDef, "group" | "motif" | "tileRadius"> & { parts: IconPart[] };
const aws = (s: Spec): IconDef => ({ ...s, group: "aws", motif: [], tileRadius: 1 });

export const AWS_ICONS: IconDef[] = [
  // ======================= Compute & Containers ==============================
  aws({
    key: "aws-ec2", label: "EC2", accent: COMPUTE, abbrev: "EC2",
    // processor chip: body, pins on every side, solid die
    parts: [
      S(rect(7, 7, 10, 10, 0.8)),
      S([9.5, 12, 14.5].map((p) => `M${p} 7 V4.6 M${p} 17 V19.4 M7 ${p} H4.6 M17 ${p} H19.4`).join(" "), 1.3),
      F(rect(9.6, 9.6, 4.8, 4.8, 0.4)),
    ],
  }),
  aws({
    key: "aws-lambda", label: "Lambda", accent: COMPUTE, abbrev: "λ",
    // λ with a top serif and a foot
    parts: [
      S("M6.6 5 H10.4 L16.6 18.8 H19", 1.8),
      S("M12.3 9.3 L6.6 18.8", 1.8),
    ],
  }),
  aws({
    key: "aws-ecs", label: "ECS", accent: COMPUTE, abbrev: "ECS",
    // three ribbed shipping containers stacked 2 + 1
    parts: [
      ...[[8.5, 5], [4.5, 13], [12.5, 13]].flatMap(([x, y]) => [
        S(rect(x, y, 7, 6, 0.5), 1.4),
        S(`M${n(x + 2.35)} ${n(y + 1.6)} V${n(y + 4.4)} M${n(x + 4.65)} ${n(y + 1.6)} V${n(y + 4.4)}`, 1.1),
      ]),
    ],
  }),
  aws({
    key: "aws-eks", label: "EKS", accent: COMPUTE, abbrev: "EKS",
    // hexagon (cluster) with a bold K
    parts: [
      S("M12 4.3 L18.7 8.15 V15.85 L12 19.7 L5.3 15.85 V8.15 Z"),
      S("M9.8 8.6 V15.4", 1.7),
      S("M14.4 8.6 L10.2 12 L14.6 15.4", 1.7),
    ],
  }),
  aws({
    key: "aws-fargate", label: "Fargate", accent: COMPUTE, abbrev: "FG",
    // serverless container: an isometric cube with a solid lid
    parts: [
      F("M12 4.6 L18.6 8.3 L12 12 L5.4 8.3 Z"),
      S("M5.4 8.3 V15.7 L12 19.4 L18.6 15.7 V8.3"),
      S("M12 12 V19.4"),
      S("M8.4 12.4 V15.2 M15.6 12.4 V15.2", 1.2),
    ],
  }),
  aws({
    key: "aws-ecr", label: "ECR", accent: COMPUTE, abbrev: "ECR",
    // registry: an image pushed down into a tray of stored images
    parts: [
      S("M4.6 11.2 V18.4 a1 1 0 0 0 1 1 H18.4 a1 1 0 0 0 1 -1 V11.2"),
      F(rect(7.3, 13.2, 4.2, 4.2, 0.5)),
      F(rect(12.5, 13.2, 4.2, 4.2, 0.5)),
      F("M10.7 4.6 H13.3 V7.8 H15.2 L12 11 L8.8 7.8 H10.7 Z"),
    ],
  }),
  aws({
    key: "aws-beanstalk", label: "Elastic Beanstalk", accent: COMPUTE, abbrev: "EB",
    // sprouting beanstalk: stem, two solid leaves, ground line
    parts: [
      S("M12 19.3 V9.6"),
      F("M12 13.6 C8.4 14 5.4 11.8 5 7.8 C9 7.5 11.6 9.8 12 13.6 Z"),
      F("M12 10.2 C12.2 6.6 15 4.6 19 4.8 C18.7 8.8 15.7 10.8 12 10.2 Z"),
      S("M7.2 19.3 H16.8"),
    ],
  }),

  // ================================ Storage ==================================
  aws({
    key: "aws-s3", label: "S3", accent: STORAGE, abbrev: "S3",
    // bucket: rim, tapered body, a band
    parts: [
      S(ellipse(12, 7.2, 7, 2.1)),
      S("M5 7.2 L7.3 17.4 a4.7 1.7 0 0 0 9.4 0 L19 7.2"),
      S("M5.9 11.3 a6.1 1.9 0 0 0 12.2 0", 1.2),
    ],
  }),
  aws({
    key: "aws-glacier", label: "S3 Glacier", accent: STORAGE, abbrev: "GLC",
    // twin ice peaks with solid snowcaps over a waterline
    parts: [
      S("M4.6 16.6 L9.6 8.4 L12.2 12 L14.6 6.6 L19.4 16.6 Z"),
      F("M14.6 6.6 L16.4 10.4 L12.9 10.4 Z"),
      F("M9.6 8.4 L11.45 11 L8.02 11 Z"),
      S("M4.6 19.2 c1.25 -1 2.45 -1 3.7 0 s2.45 1 3.7 0 s2.45 -1 3.7 0 s2.45 1 3.7 0", 1.3),
    ],
  }),
  aws({
    key: "aws-efs", label: "EFS", accent: STORAGE, abbrev: "EFS",
    // shared file system: folder with a solid tab and two-way arrow
    parts: [
      S("M4.6 7.4 a1 1 0 0 1 1 -1 H9.8 L11.6 8.4 H18.4 a1 1 0 0 1 1 1 V17.6 a1 1 0 0 1 -1 1 H5.6 a1 1 0 0 1 -1 -1 Z"),
      F("M4.6 7.4 a1 1 0 0 1 1 -1 H9.8 L11.6 8.4 H4.6 Z"),
      S("M7.6 13.4 H16.4", 1.3),
      S("M9.4 11.6 L7.6 13.4 L9.4 15.2 M14.6 11.6 L16.4 13.4 L14.6 15.2", 1.3),
    ],
  }),

  // ================================ Database =================================
  aws({
    key: "aws-rds", label: "RDS", accent: DATABASE, abbrev: "RDS",
    // managed database: cylinder framed by four scale-out corners
    parts: [
      ...cylinder(12, 8, 4.8, 1.7, 8.2, [12.1]),
      S("M4.6 8.2 V4.6 H8.2 M15.8 4.6 H19.4 V8.2 M19.4 15.8 V19.4 H15.8 M8.2 19.4 H4.6 V15.8", 1.3),
    ],
  }),
  aws({
    key: "aws-aurora", label: "Aurora", accent: DATABASE, abbrev: "AUR",
    // tall cylinder, solid cap, layered bands (distributed storage)
    parts: cylinder(12, 6.6, 6, 2, 10.6, [10.3, 13.9], true),
  }),
  aws({
    key: "aws-dynamodb", label: "DynamoDB", accent: DATABASE, abbrev: "DDB",
    // cylinder with a lightning bolt cutting across (fast key-value)
    parts: [
      ...cylinder(10.2, 7, 5.2, 1.8, 10, [12]),
      FK("M16.4 8.4 L12.4 14.3 H15.2 L13.8 19.6 L19.4 12.6 H16.5 L18.6 8.4 Z", DATABASE, 1.2),
    ],
  }),
  aws({
    key: "aws-elasticache", label: "ElastiCache", accent: DATABASE, abbrev: "EC",
    // in-memory cache: cylinder with speed lines
    parts: [
      ...cylinder(13.8, 7, 5.4, 1.8, 10, [12]),
      S("M4.6 9.6 H6.6 M4.6 12.6 H6.6 M4.6 15.6 H6.6", 1.4),
    ],
  }),

  // ===================== Networking & Content Delivery =======================
  aws({
    key: "aws-vpc", label: "VPC", accent: NETWORK, abbrev: "VPC",
    // private cloud: cloud outline with a solid padlock
    parts: [
      S("M8.2 17.4 H16.4 A3.6 3.6 0 0 0 16.8 10.2 A5 5 0 0 0 7.3 11.6 A2.95 2.95 0 0 0 8.2 17.4 Z"),
      S("M10.9 12.9 V11.9 a1.1 1.1 0 0 1 2.2 0 V12.9", 1.1),
      F(rect(9.9, 12.8, 4.2, 3.1, 0.4)),
    ],
  }),
  aws({
    key: "aws-cloudfront", label: "CloudFront", accent: NETWORK, abbrev: "CF",
    // globe: outline, meridian, three parallels
    parts: [
      S(circle(12, 12, 7)),
      S(ellipse(12, 12, 3, 7), 1.2),
      S("M5 12 H19 M6.1 8.4 H17.9 M6.1 15.6 H17.9", 1.2),
    ],
  }),
  aws({
    key: "aws-route53", label: "Route 53", accent: NETWORK, abbrev: "R53",
    // location pin: where names resolve to
    parts: [
      S("M12 4.5 a5.8 5.8 0 0 1 5.8 5.8 c0 4.2 -5.8 9.2 -5.8 9.2 s-5.8 -5 -5.8 -9.2 a5.8 5.8 0 0 1 5.8 -5.8 Z"),
      F(circle(12, 10.3, 2.3)),
    ],
  }),
  aws({
    key: "aws-elb", label: "ELB", accent: NETWORK, abbrev: "ELB",
    // one node fanning traffic out to three targets
    parts: [
      S("M8 12 L16.6 6.6 M8 12 H16.6 M8 12 L16.6 17.4", 1.4),
      F(circle(7.2, 12, 2.7)),
      F(circle(17.2, 6.6, 2)),
      F(circle(17.2, 12, 2)),
      F(circle(17.2, 17.4, 2)),
    ],
  }),

  // ======================== Application Integration ==========================
  aws({
    key: "aws-apigw", label: "API Gateway", accent: INTEGRATION, abbrev: "API",
    // code brackets around a slash
    parts: [
      S("M8.4 7 L4.6 12 L8.4 17", 1.7),
      S("M15.6 7 L19.4 12 L15.6 17", 1.7),
      S("M13.6 5.4 L10.4 18.6", 1.7),
    ],
  }),
  aws({
    key: "aws-sqs", label: "SQS", accent: INTEGRATION, abbrev: "SQS",
    // queue: box of solid messages, flow in and out
    parts: [
      S(rect(7.5, 7.5, 9, 9, 0.8)),
      F(rect(9.3, 9.6, 1.6, 4.8, 0.3)),
      F(rect(11.2, 9.6, 1.6, 4.8, 0.3)),
      F(rect(13.1, 9.6, 1.6, 4.8, 0.3)),
      S("M4.4 9.6 L6 12 L4.4 14.4 M18 9.6 L19.6 12 L18 14.4", 1.4),
    ],
  }),
  aws({
    key: "aws-sns", label: "SNS", accent: INTEGRATION, abbrev: "SNS",
    // solid megaphone with broadcast arcs
    parts: [
      F("M4.4 9.8 V14.2 H7 L13 18 V6 L7 9.8 Z"),
      S("M15.4 9.3 a3.8 3.8 0 0 1 0 5.4", 1.4),
      S("M17.4 7.2 a6.8 6.8 0 0 1 0 9.6", 1.4),
    ],
  }),
  aws({
    key: "aws-eventbridge", label: "EventBridge", accent: INTEGRATION, abbrev: "EVB",
    // event bus: a rail with producers/consumers tapping in
    parts: [
      S("M4.6 12 H19.4", 1.7),
      S("M8 12 V8.4 M16 12 V8.4 M12 12 V15.6", 1.3),
      F(rect(6.1, 4.6, 3.8, 3.8, 0.5)),
      F(rect(14.1, 4.6, 3.8, 3.8, 0.5)),
      F(rect(10.1, 15.6, 3.8, 3.8, 0.5)),
    ],
  }),
  aws({
    key: "aws-sfn", label: "Step Functions", accent: INTEGRATION, abbrev: "SFN",
    // state machine: start step → step → end state
    parts: [
      F(rect(4.6, 4.6, 5.4, 5.4, 0.6)),
      S("M10 7.3 H16.7 V12.6", 1.4),
      S("M15 10.9 L16.7 12.7 L18.4 10.9", 1.4),
      S(rect(14, 14, 5.4, 5.4, 0.6)),
      S("M7.3 10 V13.6", 1.4),
      S(circle(7.3, 16.7, 2.7)),
    ],
  }),
  aws({
    key: "aws-appsync", label: "AppSync", accent: INTEGRATION, abbrev: "SYNC",
    // two sync arrows orbiting solid data
    parts: [
      S("M5.5 12 A6.5 6.5 0 0 1 17.6 8.8"),
      S("M17.8 6.4 L17.6 8.8 L15.4 7.8", 1.5),
      S("M18.5 12 A6.5 6.5 0 0 1 6.4 15.2"),
      S("M6.2 17.6 L6.4 15.2 L8.6 16.2", 1.5),
      F(circle(12, 12, 2.4)),
    ],
  }),

  // ========================= Management & Governance =========================
  aws({
    key: "aws-cloudwatch", label: "CloudWatch", accent: MANAGEMENT, abbrev: "CW",
    // monitor dial with a heartbeat trace
    parts: [
      S(circle(12, 12, 7)),
      S("M6.4 12.4 H8.9 L10.4 8.8 L12.9 15.6 L14.6 10.8 L15.5 12.4 H17.6", 1.4),
    ],
  }),
  aws({
    key: "aws-cloudformation", label: "CloudFormation", accent: MANAGEMENT, abbrev: "CFN",
    // infrastructure stack: solid top layer + two layers below
    parts: [
      F("M12 4.8 L19.2 8.5 L12 12.2 L4.8 8.5 Z"),
      S("M4.8 12 L12 15.7 L19.2 12"),
      S("M4.8 15.5 L12 19.2 L19.2 15.5"),
    ],
  }),
  aws({
    key: "aws-cloudtrail", label: "CloudTrail", accent: MANAGEMENT, abbrev: "CT",
    // audit trail: a winding path from a start point to a planted flag
    parts: [
      S("M6.2 18.2 C11.6 18.2 6.8 13.8 12.4 13.8 H17.4", 1.5),
      F(circle(6.2, 18.2, 1.8)),
      S("M17.4 13.8 V4.8", 1.6),
      F("M17.4 4.8 L10.6 7.5 L17.4 10.2 Z"),
      F(circle(17.4, 14, 1.5)),
    ],
  }),

  // ===================== Security, Identity & Compliance =====================
  aws({
    key: "aws-iam", label: "IAM", accent: SECURITY, abbrev: "IAM",
    // identity card: solid portrait + detail lines
    parts: [
      S(rect(4.6, 6, 14.8, 12, 1)),
      F(circle(9, 10.3, 1.8)),
      F("M5.9 15.8 a3.1 2.8 0 0 1 6.2 0 Z"),
      S("M13.8 10 H17 M13.8 12.6 H17 M13.8 15.2 H16", 1.3),
    ],
  }),
  aws({
    key: "aws-cognito", label: "Cognito", accent: SECURITY, abbrev: "COG",
    // user with a verified badge
    parts: [
      S(circle(10.4, 8.4, 3.3)),
      S("M4.8 19 a5.6 5.4 0 0 1 11.2 0"),
      FK(circle(16.6, 16.3, 3.2), SECURITY, 1.2),
      K("M15.1 16.4 L16.2 17.5 L18.1 15.3", SECURITY, 1.2),
    ],
  }),
  aws({
    key: "aws-secrets-manager", label: "Secrets Manager", accent: SECURITY, abbrev: "SEC",
    // solid padlock inside a rotation arrow
    parts: [
      S("M15.75 5.5 A7.5 7.5 0 1 1 7.18 6.25"),
      F("M8.9 4.9 L6 5.1 L7.9 7.8 Z"),
      S("M10 11 V9.4 a2 2 0 0 1 4 0 V11", 1.3),
      F(rect(8.4, 10.9, 7.2, 5.6, 0.7)),
      K(circle(12, 13.2, 0.85), SECURITY, 0, true),
      K("M12 13.4 V15", SECURITY, 1.1),
    ],
  }),
  aws({
    key: "aws-kms", label: "KMS", accent: SECURITY, abbrev: "KMS",
    // key: solid bow with a hole, shaft, teeth
    parts: [
      F(circle(8.2, 12, 3.6)),
      K(circle(7.6, 12, 1.2), SECURITY, 0, true),
      S("M11.4 12 H19.2", 1.7),
      S("M16.6 12 V15 M19.2 12 V14.4", 1.7),
    ],
  }),
  aws({
    key: "aws-waf", label: "WAF", accent: SECURITY, abbrev: "WAF",
    // firewall: brick wall
    parts: [
      S(rect(4.6, 6, 14.8, 12, 0.6)),
      S("M4.6 10 H19.4 M4.6 14 H19.4", 1.2),
      S("M9.5 6 V10 M14.5 6 V10 M7 10 V14 M12 10 V14 M17 10 V14 M9.5 14 V18 M14.5 14 V18", 1.2),
    ],
  }),
  aws({
    key: "aws-shield", label: "Shield", accent: SECURITY, abbrev: "SHD",
    // shield outline with a solid half
    parts: [
      S("M12 4.5 L18.5 7 V11.5 C18.5 15.5 15.6 18.4 12 19.6 C8.4 18.4 5.5 15.5 5.5 11.5 V7 Z"),
      F("M12 6.7 L16.6 8.5 V11.6 C16.6 14.4 14.6 16.6 12 17.5 Z"),
    ],
  }),

  // ================================ Analytics ================================
  aws({
    key: "aws-kinesis", label: "Kinesis", accent: ANALYTICS, abbrev: "KIN",
    // three flowing streams
    parts: [8, 12, 16].map((y) => S(`M4.6 ${y} c2.47 -2 4.93 2 7.4 0 s4.93 -2 7.4 0`)),
  }),
  aws({
    key: "aws-redshift", label: "Redshift", accent: ANALYTICS, abbrev: "RS",
    // data warehouse: cylinder holding solid columns
    parts: [
      ...cylinder(12, 6.8, 6, 2, 10.4),
      F(rect(8.4, 12.4, 1.9, 4.6, 0.3)),
      F(rect(11.05, 10.4, 1.9, 6.6, 0.3)),
      F(rect(13.7, 11.6, 1.9, 5.4, 0.3)),
    ],
  }),
  aws({
    key: "aws-athena", label: "Athena", accent: ANALYTICS, abbrev: "ATH",
    // interactive query: magnifier over result rows
    parts: [
      S(circle(10.4, 10.4, 5.4)),
      S("M14.3 14.3 L19 19", 2.2),
      S("M7.9 8.6 H12.9 M7.9 10.5 H12.9 M7.9 12.4 H11.2", 1.2),
    ],
  }),
  aws({
    key: "aws-glue", label: "Glue", accent: ANALYTICS, abbrev: "GLUE",
    // ETL: sources poured through a funnel into a solid output
    parts: [
      S("M4.8 5.4 H19.2 L14 12 V18.8 L10 16.8 V12 Z"),
      F("M7.6 8.6 H16.4 L14.2 11.1 H9.8 Z"),
    ],
  }),

  // ========================= Artificial Intelligence =========================
  aws({
    key: "aws-sagemaker", label: "SageMaker", accent: AIML, abbrev: "SM",
    // model network: solid nodes wired through a central hub
    parts: [
      S("M6.4 6.4 L12 12 L17.6 6.4 M6.4 17.6 L12 12 L17.6 17.6 M6.4 6.4 V17.6 M17.6 6.4 V17.6", 1.3),
      ...[[6.4, 6.4], [17.6, 6.4], [6.4, 17.6], [17.6, 17.6]].map(([x, y]) => F(circle(x, y, 2))),
      FK(circle(12, 12, 2.6), AIML, 1.2),
    ],
  }),
  aws({
    key: "aws-bedrock", label: "Bedrock", accent: AIML, abbrev: "BR",
    // foundation layers with a generative spark on top
    parts: [
      F(rect(4.8, 15.4, 14.4, 3.8, 1)),
      F(rect(6.8, 11.2, 10.4, 2.9, 1)),
      F("M12 4.2 Q12.5 6.5 14.8 7 Q12.5 7.5 12 9.8 Q11.5 7.5 9.2 7 Q11.5 6.5 12 4.2 Z"),
    ],
  }),

  // ========================= Front-End Web & Mobile ==========================
  aws({
    key: "aws-amplify", label: "Amplify", accent: FRONTEND, abbrev: "AMP",
    // mobile/web app shipping: phone with a solid up-arrow
    parts: [
      S(rect(6.9, 4.5, 10.2, 15, 1.5)),
      S("M10.8 17.2 H13.2", 1.3),
      F("M12 7.4 L15.6 11.5 H13.4 V14.6 H10.6 V11.5 H8.4 Z"),
    ],
  }),
];
