// Safety net for scripts that delete or overwrite data. A seeder run against a real database by accident
// (a copied .env, a forgotten NODE_ENV) must stop instead of wiping templates or responses.
// Override on purpose with ALLOW_DESTRUCTIVE_SEED=yes.
export const refuseInProduction = (what: string): void => {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DESTRUCTIVE_SEED !== "yes") {
    console.error(`Refusing to ${what}: NODE_ENV is "production". Set ALLOW_DESTRUCTIVE_SEED=yes only if you really mean it.`);
    process.exit(1);
  }
};
