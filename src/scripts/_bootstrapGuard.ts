// Imported first by seedSuperAdmin. This script is the only way to create the first super admin, so it is not blocked in production,
// but it needs an explicit flag for that one run: ALLOW_SUPERADMIN_BOOTSTRAP=yes (see Beginso-Report/Beginso-Backend-Report/docs/insights-launch-runbook.md, "First super admin").
import { requireBootstrapFlag } from "./_guard";

requireBootstrapFlag("create or update super admins");
