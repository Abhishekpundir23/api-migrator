import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export function readInputFile(args) {
  if (args.length !== 2 || args[0] !== "--input" || !args[1]) throw new Error("usage");
  const fd = openSync(args[1], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 32_768) throw new Error("input");
    const bytes = Buffer.alloc(32_769);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size < 1 || size > 32_768) throw new Error("input");
    return JSON.parse(bytes.subarray(0, size).toString("utf8"));
  } finally { closeSync(fd); }
}
