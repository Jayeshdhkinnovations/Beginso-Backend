import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/User";

export const migrateUserTheme = async (): Promise<number> => {
  const result = await User.updateMany(
    {
      $or: [
        { theme: { $exists: false } },
        { theme: null },
      ],
    },
    {
      $set: { theme: "system" },
    }
  );

  return result.modifiedCount;
};

if (require.main === module) {
  dotenv.config();
  const run = async () => {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!mongoUri) {
      console.error("Set MONGODB_URI (or MONGO_URI). Refusing to guess which database to change.");
      process.exit(1);
    }
    console.log("Connecting to MongoDB for User Theme migration...");
    await mongoose.connect(mongoUri);
    const count = await migrateUserTheme();
    console.log(`Successfully migrated ${count} users to default theme: 'system'.`);
    await mongoose.disconnect();
  };

  run().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
