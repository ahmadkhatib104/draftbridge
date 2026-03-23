import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const serverBuildPath = resolve("build/server/index.js");
const prismaSchemaPath = resolve("prisma/schema.prisma");
const prismaImportPattern =
  /^import\s*\{([^}]+)\}\s*from\s*"@prisma\/client";$/gm;

const source = readFileSync(serverBuildPath, "utf8");
const schemaSource = readFileSync(prismaSchemaPath, "utf8");

function getPrismaEnums(schema) {
  const enums = new Map();
  const enumPattern = /enum\s+(\w+)\s*\{([\s\S]*?)\n\}/g;

  for (const match of schema.matchAll(enumPattern)) {
    const [, name, body] = match;
    const values = body
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter((line) => line && !line.startsWith("@@"))
      .map((line) => line.split(/\s+/)[0])
      .filter(Boolean);

    enums.set(name, values);
  }

  return enums;
}

const prismaEnums = getPrismaEnums(schemaSource);

function buildEnumFallback(name, values) {
  const entries = values.map((value) => `${value}: "${value}"`).join(", ");
  return `const ${name} = resolvePrismaExport("${name}") ?? { ${entries} };`;
}

if (!prismaImportPattern.test(source)) {
  console.log("No named Prisma client import found in server build.");
  process.exit(0);
}

prismaImportPattern.lastIndex = 0;

const patched = source.replace(
  prismaImportPattern,
  (_match, imports) => {
    const identifiers = imports
      .split(",")
      .map((identifier) => identifier.trim())
      .filter(Boolean);

    const runtimeImports = identifiers.filter(
      (identifier) => !prismaEnums.has(identifier),
    );
    const enumFallbacks = identifiers
      .filter((identifier) => prismaEnums.has(identifier))
      .map((identifier) =>
        buildEnumFallback(identifier, prismaEnums.get(identifier)),
      );

    const statements = [
      'import prismaClientModule from "@prisma/client";',
      "const prismaSources = [prismaClientModule, prismaClientModule?.default, prismaClientModule?.default?.default].filter(Boolean);",
      "const resolvePrismaExport = (name) => {",
      "  for (const source of prismaSources) {",
      "    const value = source?.[name];",
      '    if (typeof value !== "undefined") {',
      '      return typeof value === "object" && value !== null && "default" in value ? value.default : value;',
      "    }",
      "  }",
      "  return undefined;",
      "};",
    ];

    if (runtimeImports.length) {
      statements.push(
        ...runtimeImports.map(
          (identifier) =>
            `const ${identifier} = resolvePrismaExport("${identifier}");`,
        ),
      );
    }

    statements.push(...enumFallbacks);

    return statements.join("\n");
  },
);

writeFileSync(serverBuildPath, patched);
console.log("Patched Prisma import in server build.");
