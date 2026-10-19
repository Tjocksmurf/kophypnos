import { closeDb, runMigrations } from "./db/index.js";
import { logger } from "./logger.js";

runMigrations()
  .then(async () => {
    logger.info("migrations applied");
    await closeDb();
  })
  .catch(async (e) => {
    logger.fatal({ err: e }, "migration failed");
    await closeDb();
    process.exit(1);
  });
