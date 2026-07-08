/**
 * features/diagram/stencils/aws — AWS stencil glyphs (ORIGINAL stylized
 * line-art placeholders, NOT trademarked artwork — see icons.ts header).
 *
 * Motifs are authored in a 0..24 box (2px safe margin), stroke-only —
 * rendered as white 1.9px strokes on the category-accent tile.
 */
import type { IconDef } from "../icons";

export const AWS_ICONS: IconDef[] = [
  {
    key: "aws-ec2",
    label: "EC2",
    group: "aws",
    accent: "#ed7100",
    abbrev: "EC2",
    // chip: nested squares + connector pins
    motif: [
      "M5 5 h14 v14 h-14 Z",
      "M9 9 h6 v6 h-6 Z",
      "M9 5 V3 M15 5 V3 M9 19 V21 M15 19 V21",
      "M5 9 H3 M5 15 H3 M19 9 H21 M19 15 H21",
    ],
  },
  {
    key: "aws-lambda",
    label: "Lambda",
    group: "aws",
    accent: "#ed7100",
    abbrev: "FN",
    // stylized lambda made of two strokes
    motif: ["M8.5 4 L17 20", "M12.2 11 L7 20"],
  },
  {
    key: "aws-s3",
    label: "S3",
    group: "aws",
    accent: "#7aa116",
    abbrev: "S3",
    // bucket: elliptical rim + tapered body
    motif: [
      "M5 6.5 a7 2.2 0 1 0 14 0 a7 2.2 0 1 0 -14 0",
      "M5 6.5 L7.5 20 h9 L19 6.5",
    ],
  },
  {
    key: "aws-rds",
    label: "RDS",
    group: "aws",
    accent: "#c925d1",
    abbrev: "RDS",
    // classic database cylinder
    motif: [
      "M6 6 a6 2.5 0 1 0 12 0 a6 2.5 0 1 0 -12 0",
      "M6 6 V18 M18 6 V18",
      "M6 18 a6 2.5 0 0 0 12 0",
    ],
  },
  {
    key: "aws-dynamodb",
    label: "DynamoDB",
    group: "aws",
    accent: "#c925d1",
    abbrev: "DDB",
    // bolt-in-ring: fast key-value store
    motif: [
      "M4 12 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0",
      "M13 6 L9.5 13 H12.5 L11 18 L15.5 11 H12.5 Z",
    ],
  },
  {
    key: "aws-apigw",
    label: "API Gateway",
    group: "aws",
    accent: "#e7157b",
    abbrev: "API",
    // code brackets around a slash
    motif: [
      "M8 7 L4 12 L8 17",
      "M16 7 L20 12 L16 17",
      "M13.5 5 L10.5 19",
    ],
  },
  {
    key: "aws-sqs",
    label: "SQS",
    group: "aws",
    accent: "#e7157b",
    abbrev: "SQS",
    // two queues with a message arrow between
    motif: [
      "M3 8 h6 v8 h-6 Z",
      "M15 8 h6 v8 h-6 Z",
      "M10 12 H14 M12.5 10.5 L14 12 L12.5 13.5",
    ],
  },
  {
    key: "aws-sns",
    label: "SNS",
    group: "aws",
    accent: "#e7157b",
    abbrev: "SNS",
    // megaphone with broadcast arcs
    motif: [
      "M4 10 v4 h3.5 l7 4.5 V5.5 l-7 4.5 Z",
      "M17.5 9 a4.3 4.3 0 0 1 0 6",
      "M20 6.5 a9 9 0 0 1 0 11",
    ],
  },
  {
    key: "aws-cloudfront",
    label: "CloudFront",
    group: "aws",
    accent: "#8c4fff",
    abbrev: "CF",
    // globe: circle + equator + meridian
    motif: [
      "M3 12 a9 9 0 1 0 18 0 a9 9 0 1 0 -18 0",
      "M3 12 H21",
      "M12 3 a4.5 9 0 1 0 0 18 a4.5 9 0 1 0 0 -18",
    ],
  },
  {
    key: "aws-route53",
    label: "Route 53",
    group: "aws",
    accent: "#8c4fff",
    abbrev: "R53",
    // map pin: where names resolve to
    motif: [
      "M12 3 a6 6 0 0 1 6 6 c0 4.5 -6 12 -6 12 s-6 -7.5 -6 -12 a6 6 0 0 1 6 -6 Z",
      "M9.8 9 a2.2 2.2 0 1 0 4.4 0 a2.2 2.2 0 1 0 -4.4 0",
    ],
  },
  {
    key: "aws-vpc",
    label: "VPC",
    group: "aws",
    accent: "#8c4fff",
    abbrev: "VPC",
    // corner brackets = network boundary, inner box = private space
    motif: [
      "M4 8 V4 H8 M16 4 H20 V8 M20 16 V20 H16 M8 20 H4 V16",
      "M9 9.5 h6 v5 h-6 Z",
    ],
  },
  {
    key: "aws-elb",
    label: "ELB",
    group: "aws",
    accent: "#8c4fff",
    abbrev: "ELB",
    // one node fanning traffic to three targets
    motif: [
      "M4.5 12 a2.5 2.5 0 1 0 5 0 a2.5 2.5 0 1 0 -5 0",
      "M9.5 12 L16 5 M9.5 12 H16 M9.5 12 L16 19",
      "M16 5 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0",
      "M16 12 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0",
      "M16 19 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0",
    ],
  },
  {
    key: "aws-ecs",
    label: "ECS",
    group: "aws",
    accent: "#ed7100",
    abbrev: "ECS",
    // stacked cargo containers in a frame
    motif: [
      "M4 6 h16 v12 h-16 Z",
      "M4 12 H20",
      "M9.3 6 V18 M14.7 6 V18",
    ],
  },
  {
    key: "aws-eks",
    label: "EKS",
    group: "aws",
    accent: "#ed7100",
    abbrev: "EKS",
    // hexagon (orchestration) with a core dot
    motif: [
      "M12 3.5 L19.4 7.8 V16.2 L12 20.5 L4.6 16.2 V7.8 Z",
      "M9.5 12 a2.5 2.5 0 1 0 5 0 a2.5 2.5 0 1 0 -5 0",
    ],
  },
  {
    key: "aws-cloudwatch",
    label: "CloudWatch",
    group: "aws",
    accent: "#01a88d",
    abbrev: "CW",
    // watch face: ring + hands
    motif: [
      "M4 12 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0",
      "M12 12 V7 M12 12 L15.5 14.5",
    ],
  },
  {
    key: "aws-iam",
    label: "IAM",
    group: "aws",
    accent: "#dd344c",
    abbrev: "IAM",
    // padlock: shackle + body + keyhole
    motif: [
      "M8.5 10.5 V8 a3.5 3.5 0 0 1 7 0 V10.5",
      "M6 10.5 h12 v9.5 h-12 Z",
      "M12 14 V17",
    ],
  },
  {
    key: "aws-kinesis",
    label: "Kinesis",
    group: "aws",
    accent: "#01a88d",
    abbrev: "KIN",
    // three flowing streams
    motif: [
      "M3 7 c3 -2.5 6 2.5 9 0 s6 -2.5 9 0",
      "M3 12 c3 -2.5 6 2.5 9 0 s6 -2.5 9 0",
      "M3 17 c3 -2.5 6 2.5 9 0 s6 -2.5 9 0",
    ],
  },
  {
    key: "aws-sfn",
    label: "Step Functions",
    group: "aws",
    accent: "#e7157b",
    abbrev: "SFN",
    // two steps joined by an elbow arrow
    motif: [
      "M3 3 h6 v6 h-6 Z",
      "M15 15 h6 v6 h-6 Z",
      "M9 6 H18 V15 M16.5 13.2 L18 15 L19.5 13.2",
    ],
  },
];
