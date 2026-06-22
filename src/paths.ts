import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, "..");
export const DATA_DIR = path.join(ROOT, "data");
export const SNAPSHOTS_DIR = path.join(DATA_DIR, "snapshots");
export const CASINOS_DIR = path.join(ROOT, "casinos");
export const REPORT_PATH = path.join(DATA_DIR, "report.html");

export const snapshotsDirFor = (casino: string) => path.join(SNAPSHOTS_DIR, slugify(casino));

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "x"
  );
}
