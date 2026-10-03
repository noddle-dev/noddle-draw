/**
 * features/library/builtins/cloud — AWS / Azure / Google Cloud icon packs,
 * GENERATED from the icon registry (features/diagram/icons + stencils/*), so a
 * new stencil shows up in the Library with no extra authoring. Each item is a
 * SINGLE icon shape (Lucid-style: the node is the icon, caption below it).
 */
import { CATEGORY_META, ICON_CATEGORIES, ICONS, type IconGroup } from "../../diagram";
import type { LibraryItem, LibraryPack, LibHue } from "../types";

const SIDE = 64;

function pack(group: IconGroup, id: string, name: string, blurb: string, hue: LibHue): LibraryPack {
  // Grouped by service cluster in draw.io order (Compute, Containers, …).
  const order = (c?: string) => {
    const i = ICON_CATEGORIES.findIndex((x) => x.id === c);
    return i < 0 ? 99 : i;
  };
  const items: LibraryItem[] = Object.values(ICONS)
    .filter((d) => d.group === group)
    .sort((a, b) => order(a.category) - order(b.category))
    .map((d) => ({
      section: d.category ? CATEGORY_META[d.category].label : "Other",
      sectionColor: d.category ? CATEGORY_META[d.category].color : undefined,
      id: `${id}-${d.key}`,
      name: d.label,
      tags: [
        d.label.toLowerCase(),
        d.key.replace(/^[a-z]+-/, ""),
        group,
        "cloud",
        "icon",
        ...(d.category ? [d.category, CATEGORY_META[d.category].label.toLowerCase()] : []),
      ],
      nodes: [
        {
          id: "n1",
          kind: "icon",
          iconKey: d.key,
          x: 0,
          y: 0,
          w: SIDE,
          h: SIDE,
          text: d.label,
          fill: "#ffffff",
          stroke: "#2d3142",
          strokeWidth: 2,
          fontSize: 13,
        },
      ],
      edges: [],
      w: SIDE,
      h: SIDE,
    }));
  return { id, name, blurb, hue, items };
}

export const AWS_PACK = pack("aws", "aws", "AWS", "Amazon Web Services — compute, storage, data, networking, AI", "ember");
export const AZURE_PACK = pack("azure", "azure", "Azure", "Microsoft Azure — apps, data, integration, identity, AI", "sky");
export const GCP_PACK = pack("gcp", "gcp", "Google Cloud", "Google Cloud — compute, data & analytics, networking, AI", "mint");
