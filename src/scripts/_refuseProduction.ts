// Imported first by the seed and test-data scripts that write to the database and must never run against a real one.
// Loading it is the check: it stops the script (exit 1) when NODE_ENV is "production", before the script's own imports load.
// Override on purpose with ALLOW_DESTRUCTIVE_SEED=yes (see _guard.ts).
import path from "path";
import { refuseInProduction } from "./_guard";

refuseInProduction(`run ${path.basename(process.argv[1] ?? "this script")}`);
