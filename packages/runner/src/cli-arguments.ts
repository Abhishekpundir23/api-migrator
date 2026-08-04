export type RunnerCliArguments =
  | { phase: "prepare"; planPath: string; sourcePath: string; dependenciesPath: string; installationPath: string }
  | { phase: "install"; planPath: string; installationPath: string; preparedStateDigest: string }
  | {
      phase: "migrate"; planPath: string; sourcePath: string; dependenciesPath: string;
      installationPath: string; preparedStateDigest: string; installStateDigest: string; outputPath: string;
    }
  | {
      phase: "verify"; planPath: string; inputPath: string; dependenciesPath: string;
      dependencyStateDigest: string; resultPath: string;
    };

const ABSOLUTE_PATH = /^\/(?:[^\0\r\n]+)$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function parseRunnerCliArguments(argv: readonly string[]): RunnerCliArguments {
  if (argv[0] === "prepare") {
    exactShape(argv, [
      "prepare", "--plan", "", "--source", "", "--dependencies", "", "--installation", "",
    ]);
    return {
      phase: "prepare",
      planPath: absolute(argv[2]!, "plan"),
      sourcePath: absolute(argv[4]!, "source"),
      dependenciesPath: absolute(argv[6]!, "dependencies"),
      installationPath: absolute(argv[8]!, "installation"),
    };
  }
  if (argv[0] === "install") {
    exactShape(argv, [
      "install", "--plan", "", "--installation", "", "--prepared-state-digest", "",
    ]);
    return {
      phase: "install",
      planPath: absolute(argv[2]!, "plan"),
      installationPath: absolute(argv[4]!, "installation"),
      preparedStateDigest: digest(argv[6]!, "prepared state"),
    };
  }
  if (argv[0] === "migrate") {
    exactShape(argv, [
      "migrate", "--plan", "", "--source", "", "--dependencies", "", "--installation", "",
      "--prepared-state-digest", "", "--install-state-digest", "", "--output", "",
    ]);
    return {
      phase: "migrate",
      planPath: absolute(argv[2]!, "plan"),
      sourcePath: absolute(argv[4]!, "source"),
      dependenciesPath: absolute(argv[6]!, "dependencies"),
      installationPath: absolute(argv[8]!, "installation"),
      preparedStateDigest: digest(argv[10]!, "prepared state"),
      installStateDigest: digest(argv[12]!, "install state"),
      outputPath: absolute(argv[14]!, "output"),
    };
  }
  if (argv[0] === "verify") {
    exactShape(argv, [
      "verify", "--plan", "", "--input", "", "--dependencies", "", "--dependency-state-digest", "",
      "--result", "",
    ]);
    return {
      phase: "verify",
      planPath: absolute(argv[2]!, "plan"),
      inputPath: absolute(argv[4]!, "input"),
      dependenciesPath: absolute(argv[6]!, "dependencies"),
      dependencyStateDigest: digest(argv[8]!, "dependency state"),
      resultPath: absolute(argv[10]!, "result"),
    };
  }
  throw new Error("Runner phase must be prepare, install, migrate, or verify");
}

function digest(value: string, label: string): string {
  if (!DIGEST.test(value)) throw new Error(`Runner ${label} digest is invalid`);
  return value;
}

function exactShape(actual: readonly string[], expected: readonly string[]): void {
  if (actual.length !== expected.length) throw new Error("Runner arguments do not match the fixed phase scope");
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] && actual[index] !== expected[index]) {
      throw new Error("Runner arguments are missing, duplicated, reordered, or unsupported");
    }
  }
}

function absolute(value: string, label: string): string {
  if (!ABSOLUTE_PATH.test(value) || value.length > 4_096) {
    throw new Error(`Runner ${label} path must be absolute and bounded`);
  }
  return value;
}
