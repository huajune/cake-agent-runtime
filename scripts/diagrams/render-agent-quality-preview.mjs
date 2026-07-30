import fs from "node:fs";
import path from "node:path";

// 与 build 脚本同目录约定：读写都落 docs 图库，不依赖调用时的 cwd。
const DIAGRAM_DIR = path.resolve(import.meta.dirname, "../../docs/architecture/diagrams");
const inputPath = path.join(DIAGRAM_DIR, "agent-quality-assurance.excalidraw");
const outputPath = path.join(DIAGRAM_DIR, "agent-quality-assurance.svg");
const scene = JSON.parse(fs.readFileSync(inputPath, "utf8"));

const escapeXml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const shapeIdsWithShadow = new Set([
  "question-card",
  "generate-card",
  "guard-card",
  "send-card",
  "observability",
  "auto-audit",
  "ops-feedback",
  "repair-loop",
  "new-checks",
  "governance-doc",
]);

function renderElement(element) {
  const strokeDasharray = element.strokeStyle === "dashed" ? ' stroke-dasharray="10 8"' : "";
  const filter = shapeIdsWithShadow.has(element.id) ? ' filter="url(#soft-shadow)"' : "";

  if (element.type === "rectangle") {
    return `<rect x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" rx="14" fill="${element.backgroundColor}" stroke="${element.strokeColor}" stroke-width="${element.strokeWidth}"${strokeDasharray}${filter}/>`;
  }

  if (element.type === "ellipse") {
    return `<ellipse cx="${element.x + element.width / 2}" cy="${element.y + element.height / 2}" rx="${element.width / 2}" ry="${element.height / 2}" fill="${element.backgroundColor}" stroke="${element.strokeColor}" stroke-width="${element.strokeWidth}"/>`;
  }

  if (element.type === "arrow") {
    const points = element.points.map(([x, y]) => `${element.x + x},${element.y + y}`).join(" ");
    const markerEnd = element.endArrowhead ? ' marker-end="url(#arrowhead)"' : "";
    const markerStart = element.startArrowhead ? ' marker-start="url(#arrowhead)"' : "";
    return `<polyline points="${points}" fill="none" stroke="${element.strokeColor}" stroke-width="${element.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${strokeDasharray}${markerStart}${markerEnd}/>`;
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
    return `<text x="${element.x}" y="${element.y + element.fontSize}" fill="${element.strokeColor}" font-family="PingFang SC, Noto Sans SC, Microsoft YaHei, Arial, sans-serif" font-size="${element.fontSize}" font-weight="${element.fontSize >= 19 ? 600 : 400}" letter-spacing="${element.fontSize >= 30 ? 0.2 : 0}">${tspans}</text>`;
  }

  return "";
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1400" viewBox="0 0 1440 1400">
  <defs>
    <filter id="soft-shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="5" stdDeviation="7" flood-color="#183153" flood-opacity="0.10"/>
    </filter>
    <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="context-stroke"/>
    </marker>
  </defs>
  <rect width="1440" height="1400" fill="${scene.appState.viewBackgroundColor}"/>
  ${scene.elements.map(renderElement).join("\n  ")}
</svg>
`;

fs.writeFileSync(outputPath, svg);
console.log(outputPath);
