// Safety net for scripts that delete or overwrite data. A seeder run against a real database by accident
// (a copied .env, a forgotten NODE_ENV) must stop instead of wiping templates or responses.
// Override on purpose with ALLOW_DESTRUCTIVE_SEED=yes.
export const refuseInProduction = (what: string): void => {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DESTRUCTIVE_SEED !== "yes") {
    console.error(`Refusing to ${what}: NODE_ENV is "production". Set ALLOW_DESTRUCTIVE_SEED=yes only if you really mean it.`);
    process.exit(1);
  }
};

// For the one script that must be able to run in production (the first super admin): it needs an explicit flag for that run, not a silent pass.
export const requireBootstrapFlag = (what: string): void => {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_SUPERADMIN_BOOTSTRAP !== "yes") {
    console.error(`Refusing to ${what}: NODE_ENV is "production". If you really are creating the first super admin, set ALLOW_SUPERADMIN_BOOTSTRAP=yes for this one run.`);
    process.exit(1);
  }
};
