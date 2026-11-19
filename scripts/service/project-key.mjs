import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function projectKeyPath() {
  const base = process.env.XDG_CONFIG_HOME;
  return join(base && isAbsolute(base) ? base : join(homedir(), ".config"), "api-migrator", "openai-project.key");
}

// Only the opt-in operator-side API path calls this function.
export function reviewApiKey() {
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();
  let fd;
  try {
    fd = openSync(projectKeyPath(), constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 2048 || (process.platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) {
      throw new Error("Use a private, owner-only project key file.");
    }
    const buffer = Buffer.alloc(2049);
    const size = readSync(fd, buffer, 0, buffer.length, null);
    const key = buffer.toString("utf8", 0, size).trim();
    if (size > 2048 || !/^\S+$/.test(key)) throw new Error("Invalid project key file.");
    return key;
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Set OPENAI_API_KEY or configure the operator's local project key file");
    throw new Error("Cannot read the private project key file; check ownership, permissions and content");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
