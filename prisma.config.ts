try {
  process.loadEnvFile?.();
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes("ENOENT")) {
    throw error;
  }
}

import { defineConfig } from "prisma/config";

const fallbackDatabaseUrl =
  "postgresql://draftbridge:draftbridge@localhost:5432/draftbridge";
const databaseUrl = process.env.DATABASE_URL ?? fallbackDatabaseUrl;

export default defineConfig({
  schema: "prisma/schema.prisma",
  engine: "classic",
  datasource: {
    url: databaseUrl,
  },
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
});
