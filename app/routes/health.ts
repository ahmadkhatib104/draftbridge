import db from "../db.server";
import { getAppUrl } from "../lib/env.server";

export const loader = async () => {
  await db.$queryRawUnsafe("SELECT 1");

  const deployment = {
    branch: process.env.RENDER_GIT_BRANCH ?? null,
    commit: process.env.RENDER_GIT_COMMIT ?? process.env.RENDER_GIT_COMMIT_SHA ?? null,
    serviceId: process.env.RENDER_SERVICE_ID ?? null,
    nodeEnv: process.env.NODE_ENV ?? null,
  };

  return Response.json(
    {
      ok: true,
      service: "draftbridge",
      timestamp: new Date().toISOString(),
      url: getAppUrl(),
      deployment,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
};
