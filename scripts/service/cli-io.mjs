import { closeSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function required(values, key) {
  if (!values[key]?.trim()) throw new Error(`Missing --${key}. Use --help for usage.`);
  return values[key];
}

export function outputPath(path, root) {
  const target = join(realpathSync(dirname(resolve(path))), basename(path));
  if (root) {
    const rel = relative(root, target);
    if (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel))
      throw new Error("Choose an output directory outside the assessed repository.");
  }
  return target;
}

// Reserve all requested outputs before writing any of them or sending an API request.
export async function writeNewFiles(paths, produce) {
  const opened = [];
  try {
    for (const path of paths) opened.push({ path, fd: openSync(path, "wx", 0o600) });
    const documents = await produce();
    for (let i = 0; i < documents.length; i++) writeFileSync(opened[i].fd, documents[i], "utf8");
  } catch (error) {
    for (const { path } of opened) unlinkSync(path);
    throw error;
  } finally {
    for (const { fd } of opened) closeSync(fd);
  }
}
