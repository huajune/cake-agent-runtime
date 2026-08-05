import fs from "node:fs";
import path from "node:path";

const diagramDir = path.resolve(import.meta.dirname, "../../docs/architecture/diagrams");
const diagrams = [
  { name: "memory-relationship-system", width: 1740, height: 1920 },
  { name: "candidate-profile-model", width: 1740, height: 2010 },
];

const escapeXml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function renderElement(element) {
  const dash = element.strokeStyle === "dashed" ? ' stroke-dasharray="9 7"' : "";
  const shadow =
    element.type === "rectangle" && element.strokeWidth >= 2
      ? ' filter="url(#soft-shadow)"'
      : "";

  if (element.type === "rectangle") {
    return `<rect x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" rx="12" fill="${element.backgroundColor}" stroke="${element.strokeColor}" stroke-width="${element.strokeWidth}"${dash}${shadow}/>`;
  }
  if (element.type === "ellipse") {
    return `<ellipse cx="${element.x + element.width / 2}" cy="${element.y + element.height / 2}" rx="${element.width / 2}" ry="${element.height / 2}" fill="${element.backgroundColor}" stroke="${element.strokeColor}" stroke-width="${element.strokeWidth}"${shadow}/>`;
  }
  if (element.type === "arrow") {
    const points = element.points
      .map(([x, y]) => `${element.x + x},${element.y + y}`)
      .join(" ");
    const markerEnd = element.endArrowhead ? ' marker-end="url(#arrowhead)"' : "";
    return `<polyline points="${points}" fill="none" stroke="${element.strokeColor}" stroke-width="${element.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${dash}${markerEnd}/>`;
  }
  if (element.type === "text") {
    const lines = element.text.split("\n");
    const lineHeight = element.fontSize * element.lineHeight;
    const tspans = lines
      .map(
        (line, index) =>
          `<tspan x="${element.x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`,
      )
      .join("");
    return `<text x="${element.x}" y="${element.y + element.fontSize}" fill="${element.strokeColor}" font-family="PingFang SC, Noto Sans SC, Microsoft YaHei, Arial, sans-serif" font-size="${element.fontSize}" font-weight="${element.fontSize >= 18 ? 600 : 400}">${tspans}</text>`;
  }
  return "";
}

for (const diagram of diagrams) {
  const inputPath = path.join(diagramDir, `${diagram.name}.excalidraw`);
  const outputPath = path.join(diagramDir, `${diagram.name}.svg`);
  const scene = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${diagram.width}" height="${diagram.height}" viewBox="0 0 ${diagram.width} ${diagram.height}">
  <defs>
    <filter id="soft-shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#0f172a" flood-opacity="0.07"/>
    </filter>
    <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="context-stroke"/>
    </marker>
  </defs>
  <rect width="${diagram.width}" height="${diagram.height}" fill="${scene.appState.viewBackgroundColor}"/>
  ${scene.elements.map(renderElement).join("\n  ")}
</svg>
`;
  fs.writeFileSync(outputPath, svg);
  console.log(outputPath);
}
