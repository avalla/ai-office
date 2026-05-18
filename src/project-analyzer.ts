import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join, relative } from "path";

export interface ProjectAnalysis {
  projectName: string;
  projectType: string;
  language?: string;
  languageToolchain?: string;
  jsPackageManager?: string;
  packageManager?: string;
  uiFramework?: string;
  designSystem?: string;
  testRunner?: string;
  typecheckCmd?: string;
  lintCmd?: string;
  testCmd?: string;
  hasSupabase: boolean;
  hasPostgres: boolean;
  hasUi: boolean;
  hasInfra: boolean;
  hasAuth: boolean;
  hasPayments: boolean;
  hasMonorepo: boolean;
  riskAreas: string[];
  qualityGates: string[];
  recommendedPipeline: string;
  recommendedRoles: string[];
  repositorySignals: string[];
}

const ignoreDirs = new Set([
  ".ai-office",
  ".ai-office-TMP",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "test-results",
]);

const interestingFiles = new Set([
  ".env",
  ".env.example",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  "components.json",
  "Dockerfile",
  "deno.json",
  "deno.jsonc",
  "fly.toml",
  "go.mod",
  "netlify.toml",
  "postcss.config.cjs",
  "postcss.config.js",
  "postcss.config.mjs",
  "pyproject.toml",
  "supabase",
  "tailwind.config.cjs",
  "tailwind.config.js",
  "tailwind.config.mjs",
  "tailwind.config.ts",
  "tsconfig.json",
  "vercel.json",
  "wrangler.toml",
]);

function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function safeReadText(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function detectJsPackageManager(root: string, hasPackageJson: boolean): string | undefined {
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (hasPackageJson || existsSync(join(root, "package-lock.json"))) return "npm";
  return undefined;
}

function scriptCommand(packageManager: string, scriptName: string): string {
  switch (packageManager) {
    case "bun":
      return `bun run ${scriptName}`;
    case "pnpm":
      return `pnpm run ${scriptName}`;
    case "yarn":
      return `yarn ${scriptName}`;
    default:
      return `npm run ${scriptName}`;
  }
}

function execCommand(packageManager: string, binary: string, args = ""): string {
  const suffix = args ? ` ${args}` : "";
  switch (packageManager) {
    case "bun":
      return `bunx ${binary}${suffix}`;
    case "pnpm":
      return `pnpm exec ${binary}${suffix}`;
    case "yarn":
      return `yarn ${binary}${suffix}`;
    default:
      return `npx ${binary}${suffix}`;
  }
}

function emit(key: string, value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  const text = Array.isArray(value) ? value.join(", ") : String(value);
  console.log(`${key}\t${text.replace(/\r?\n/g, " ").trim()}`);
}

export function analyzeProject(root: string): ProjectAnalysis {
  const packageJsonPaths = new Set<string>();
  const discoveredFiles = new Set<string>();
  const discoveredPaths = new Set<string>();

  function walk(dir: string, depth = 0): void {
    if (depth > 5) return;

    for (const entry of readdirSync(dir)) {
      if (ignoreDirs.has(entry)) continue;

      const fullPath = join(dir, entry);
      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        if (interestingFiles.has(entry) || entry === ".github" || entry === "migrations" || entry === "apps" || entry === "packages") {
          discoveredPaths.add(relative(root, fullPath));
        }
        walk(fullPath, depth + 1);
        continue;
      }

      if (entry === "package.json") packageJsonPaths.add(fullPath);
      if (interestingFiles.has(entry)) {
        discoveredFiles.add(entry);
        discoveredPaths.add(relative(root, fullPath));
      }
    }
  }

  walk(root);

  const rootPackagePath = join(root, "package.json");
  const rootPackage = existsSync(rootPackagePath) ? safeReadJson(rootPackagePath) : null;
  const allPackages = Array.from(packageJsonPaths).map((packagePath) => safeReadJson(packagePath)).filter(Boolean) as Record<string, unknown>[];
  const dependencyNames = new Set<string>();

  for (const pkg of allPackages) {
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const group = pkg[field];
      if (!group || typeof group !== "object") continue;
      for (const name of Object.keys(group)) dependencyNames.add(name);
    }
  }

  const dependencies = Array.from(dependencyNames);
  const hasDependency = (name: string) => dependencyNames.has(name);
  const hasDependencyPrefix = (prefix: string) => dependencies.some((name) => name.startsWith(prefix));
  const jsPackageManager = detectJsPackageManager(root, Boolean(rootPackage));
  const scripts = rootPackage && typeof rootPackage.scripts === "object" ? rootPackage.scripts as Record<string, unknown> : {};
  const pickScript = (candidates: string[]) => candidates.find((candidate) => typeof scripts[candidate] === "string") || "";
  const rootDirName = basename(root);

  let projectName = rootDirName;
  let typecheckCmd = "";
  let lintCmd = "";
  let testCmd = "";
  let testRunner = "";
  let uiFramework = "";
  let designSystem = "";
  let language = "";
  let languageToolchain = "";

  const pyprojectText = safeReadText(join(root, "pyproject.toml"));
  const goModText = safeReadText(join(root, "go.mod"));
  const hasRootDenoConfig = existsSync(join(root, "deno.json")) || existsSync(join(root, "deno.jsonc"));

  if (rootPackage && jsPackageManager) {
    language = hasDependency("typescript") || discoveredPaths.has("tsconfig.json") ? "TypeScript" : "JavaScript";
    languageToolchain = jsPackageManager;
    if (typeof rootPackage.name === "string" && rootPackage.name.trim()) {
      projectName = rootPackage.name.replace(/^@[^/]+\//, "");
    }

    const typecheckScript = pickScript(["typecheck", "typecheck:all", "type-check", "check-types", "tsc"]);
    if (typecheckScript) typecheckCmd = scriptCommand(jsPackageManager, typecheckScript);
    else if (hasDependency("typescript")) typecheckCmd = execCommand(jsPackageManager, "tsc", "--noEmit");

    const lintScript = pickScript(["lint", "lint:all"]);
    if (lintScript) lintCmd = scriptCommand(jsPackageManager, lintScript);
    else if (hasDependency("eslint")) lintCmd = execCommand(jsPackageManager, "eslint", ".");

    const testScript = pickScript(["test", "test:all", "test:ci", "test:unit", "test:vitest", "test:e2e"]);
    if (testScript) testCmd = scriptCommand(jsPackageManager, testScript);
    else if (hasDependency("vitest")) testCmd = execCommand(jsPackageManager, "vitest", "run");
    else if (hasDependency("jest")) testCmd = execCommand(jsPackageManager, "jest");
    else if (hasDependency("@playwright/test")) testCmd = execCommand(jsPackageManager, "playwright", "test");

    const scriptText = `${testCmd} ${Object.values(scripts).join(" ")}`.toLowerCase();
    if (hasDependency("vitest") || scriptText.includes("vitest")) testRunner = "vitest";
    else if (hasDependency("jest") || scriptText.includes("jest")) testRunner = "jest";
    else if (scriptText.includes("bun test")) testRunner = "bun test";
    else if (hasDependency("@playwright/test") || scriptText.includes("playwright")) testRunner = "playwright";

    if (hasDependency("react-native") || hasDependency("expo") || hasDependency("react-native-paper") || hasDependency("nativewind")) uiFramework = "react-native";
    else if (hasDependency("react") || hasDependency("react-dom") || hasDependency("next")) uiFramework = "react";
    else if (hasDependency("vue") || hasDependency("nuxt")) uiFramework = "vue";
    else if (hasDependency("svelte") || hasDependency("@sveltejs/kit")) uiFramework = "svelte";
    else if (hasDependency("solid-js") || hasDependency("solid-start")) uiFramework = "solid";
    else if (hasDependency("@angular/core")) uiFramework = "angular";

    if (hasDependency("@shadcn/ui") || discoveredFiles.has("components.json")) designSystem = "shadcn/ui";
    else if (hasDependency("@mui/material")) designSystem = "MUI";
    else if (hasDependency("@chakra-ui/react")) designSystem = "Chakra UI";
    else if (hasDependency("@mantine/core")) designSystem = "Mantine";
    else if (hasDependency("antd")) designSystem = "Ant Design";
    else if (hasDependency("react-native-paper")) designSystem = "React Native Paper";
    else if (hasDependency("tailwindcss") || hasDependency("@tailwindcss/cli") || hasDependency("@tailwindcss/vite") || discoveredFiles.has("tailwind.config.js") || discoveredFiles.has("tailwind.config.ts") || discoveredFiles.has("tailwind.config.cjs") || discoveredFiles.has("tailwind.config.mjs")) designSystem = "Tailwind CSS";
    else if (hasDependencyPrefix("@radix-ui/")) designSystem = "Radix UI";
  } else if (hasRootDenoConfig) {
    language = "TypeScript";
    languageToolchain = "deno";
    typecheckCmd = "deno check .";
    lintCmd = "deno lint";
    testCmd = "deno test";
    testRunner = "deno test";
  } else if (pyprojectText) {
    language = "Python";
    languageToolchain = "pytest / ruff / mypy";
    const pyprojectName =
      pyprojectText.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1] ||
      pyprojectText.match(/^\s*\[project\][\s\S]*?^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
    projectName = pyprojectName || rootDirName;
    typecheckCmd = "mypy src";
    lintCmd = "ruff check .";
    testCmd = "pytest";
    testRunner = "pytest";
  } else if (goModText) {
    language = "Go";
    languageToolchain = "go test / go vet";
    const moduleName = goModText.match(/^module\s+(.+)$/m)?.[1]?.trim();
    projectName = moduleName ? moduleName.split("/").pop() || rootDirName : rootDirName;
    typecheckCmd = "go vet ./...";
    lintCmd = "golangci-lint run";
    testCmd = "go test ./...";
    testRunner = "go test";
  }

  const hasPath = (pattern: RegExp) => Array.from(discoveredPaths).some((value) => pattern.test(value));
  const hasEnvFile = [".env", ".env.example", ".env.local", ".env.development", ".env.production", ".env.test"].some((name) => discoveredFiles.has(name));
  const hasSupabase = hasDependency("@supabase/supabase-js") || hasPath(/^supabase(\/|$)/) || hasPath(/migrations/i);
  const hasPostgres = hasDependency("pg") || hasDependency("postgres") || hasDependency("drizzle-orm") || hasDependency("prisma") || hasSupabase;
  const hasUi = Boolean(uiFramework);
  const hasInfra = discoveredFiles.has("Dockerfile") || discoveredFiles.has("wrangler.toml") || discoveredFiles.has("vercel.json") || discoveredFiles.has("netlify.toml") || discoveredFiles.has("fly.toml") || hasPath(/^\.github\/workflows\//);
  const hasAuth = hasDependency("next-auth") || hasDependency("@clerk/nextjs") || hasDependency("@auth/core") || hasSupabase;
  const hasPayments = hasDependency("stripe") || hasDependency("@stripe/stripe-js");
  const hasMonorepo = hasPath(/^(apps|packages)(\/|$)/) || Boolean(rootPackage?.workspaces);

  let projectType = "software project";
  if (hasSupabase) projectType = "Supabase/Postgres application";
  else if (hasUi && !hasPostgres) projectType = "frontend application";
  else if (hasInfra && !hasUi) projectType = "infra-heavy project";
  else if (rootPackage) projectType = "TypeScript/JavaScript application";
  else if (hasRootDenoConfig) projectType = "Deno application";
  else if (pyprojectText) projectType = "Python application";
  else if (goModText) projectType = "Go application";

  let recommendedPipeline = "request -> clarify -> PRD -> architecture -> plan -> implementation -> tests -> review -> release";
  if (hasSupabase) recommendedPipeline = "request -> data model -> RLS/security design -> migration plan -> pgTAP tests -> implementation -> QA -> review -> release";
  else if (hasUi && !hasPostgres) recommendedPipeline = "request -> UX notes -> component plan -> implementation -> visual QA -> accessibility review -> release";
  else if (hasInfra) recommendedPipeline = "request -> risk assessment -> architecture -> runbook -> dry-run -> implementation -> validation -> rollback plan -> release";

  const recommendedRoles = ["product", "architect", "developer", "qa", "reviewer"];
  if (hasSupabase) recommendedRoles.push("database-security");
  if (hasUi) recommendedRoles.push("ux");
  if (hasInfra) recommendedRoles.push("ops");
  if (hasAuth || hasPayments || hasEnvFile) recommendedRoles.push("security");

  const riskAreas: string[] = [];
  if (hasAuth) riskAreas.push("auth");
  if (hasPayments) riskAreas.push("payments");
  if (hasSupabase) riskAreas.push("RLS", "migrations");
  if (hasInfra) riskAreas.push("infra");
  if (hasEnvFile) riskAreas.push("secrets");
  if (riskAreas.length === 0) riskAreas.push("general correctness");

  const qualityGates = ["typecheck", "lint", "tests", "review"];
  if (hasUi) qualityGates.push("visual QA", "accessibility");
  if (hasSupabase) qualityGates.push("migration review", "RLS review");
  if (hasInfra) qualityGates.push("dry-run", "rollback plan");
  if (hasAuth || hasPayments || hasEnvFile) qualityGates.push("security review");

  const repositorySignals = [
    jsPackageManager ? `JavaScript package manager: ${jsPackageManager}` : "JavaScript package manager: none detected",
    language ? `language: ${language}` : "",
    languageToolchain ? `toolchain: ${languageToolchain}` : "",
    uiFramework ? `frontend: ${uiFramework}` : "",
    designSystem ? `design system: ${designSystem}` : "",
    testRunner ? `test runner: ${testRunner}` : "",
    hasMonorepo ? "monorepo: yes" : "",
    hasSupabase ? "supabase/postgres: yes" : "",
    hasInfra ? "deployment/infra hints: yes" : "",
    hasEnvFile ? "env files present: yes" : "",
  ].filter(Boolean);

  return {
    projectName,
    projectType,
    language: language || undefined,
    languageToolchain: languageToolchain || undefined,
    jsPackageManager,
    packageManager: jsPackageManager,
    uiFramework: uiFramework || undefined,
    designSystem: designSystem || undefined,
    testRunner: testRunner || undefined,
    typecheckCmd: typecheckCmd || undefined,
    lintCmd: lintCmd || undefined,
    testCmd: testCmd || undefined,
    hasSupabase,
    hasPostgres,
    hasUi,
    hasInfra,
    hasAuth,
    hasPayments,
    hasMonorepo,
    riskAreas,
    qualityGates,
    recommendedPipeline,
    recommendedRoles,
    repositorySignals,
  };
}

if (import.meta.main) {
  const rootArg = process.argv[2] || process.env.PROJECT_ROOT || ".";
  const analysis = analyzeProject(rootArg);
  const summary = [
    analysis.jsPackageManager,
    analysis.language,
    analysis.uiFramework,
    analysis.designSystem,
    analysis.testRunner,
  ].filter(Boolean).join(", ");

  emit("PROJECT_NAME", analysis.projectName);
  emit("PACKAGE_MANAGER", analysis.jsPackageManager);
  emit("LANGUAGE_TOOLCHAIN", analysis.languageToolchain);
  emit("LANGUAGE", analysis.language);
  emit("PROJECT_TYPE", analysis.projectType);
  emit("TYPECHECK_CMD", analysis.typecheckCmd);
  emit("LINT_CMD", analysis.lintCmd);
  emit("TEST_CMD", analysis.testCmd);
  emit("TEST_RUNNER", analysis.testRunner);
  emit("UI_FRAMEWORK", analysis.uiFramework);
  emit("DESIGN_SYSTEM", analysis.designSystem);
  emit("PIPELINE", analysis.recommendedPipeline);
  emit("ROLES", analysis.recommendedRoles.join(","));
  emit("RISK_AREAS", analysis.riskAreas.join(", "));
  emit("QUALITY_GATES", analysis.qualityGates.join(", "));
  emit("REPOSITORY_SIGNALS", analysis.repositorySignals.join("; "));
  emit("SUMMARY", summary);
}
