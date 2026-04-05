import { drainPendingInboundMessages } from "../app/services/intake.server";

async function main() {
  const limitArg = process.argv[2];
  const limit = limitArg ? Number.parseInt(limitArg, 10) : 25;

  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("Pass a positive numeric limit, for example: npm run inbound:drain -- 25");
  }

  const processedCount = await drainPendingInboundMessages(limit);
  console.log(`Processed ${processedCount} pending inbound message${processedCount === 1 ? "" : "s"}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
