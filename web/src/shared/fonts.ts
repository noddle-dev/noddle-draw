/** Self-hosted fonts, also embedded into PNG/SVG exports and offline captures. */
import inter from "../assets/fonts/Inter.ttf?url";
import cousine from "../assets/fonts/Cousine.ttf?url";
import gentium from "../assets/fonts/GentiumBookPlus.ttf?url";
import kalam from "../assets/fonts/Kalam.ttf?url";

const FONTS = [
  { name: "Inter", url: inter, weight: "100 900" },
  { name: "Cousine", url: cousine, weight: "400" },
  { name: "Gentium Book Plus", url: gentium, weight: "400" },
  { name: "Kalam", url: kalam, weight: "400" },
];
const data = new Map<string, string>();
let loading: Promise<void> | null = null;

export function ensureFonts(): Promise<void> {
  return loading ??= Promise.all(FONTS.map(async (font) => {
    let url = font.url;
    if (!url.startsWith("data:")) {
      const res = await fetch(url);
      if (!res.ok) throw new Error("Font unavailable");
      const bytes = new Uint8Array(await res.arrayBuffer());
      const chunks = [];
      for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
      url = "data:font/ttf;base64," + btoa(chunks.join(""));
    }
    data.set(font.name, url);
    const face = await new FontFace(font.name, `url("${url}")`, { weight: font.weight }).load();
    document.fonts.add(face);
  })).then(() => undefined);
}

export async function embedFonts(svg: string): Promise<string> {
  await ensureFonts();
  const css = FONTS.filter((font) => svg.includes(font.name)).map((font) =>
    `@font-face{font-family:'${font.name}';src:url('${data.get(font.name)}') format('truetype');font-weight:${font.weight};}`,
  ).join("");
  return svg.replace(/(<svg\b[^>]*>)/, `$1<defs><style>${css}</style></defs>`);
}
