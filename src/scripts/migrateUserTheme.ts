import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/User";

dotenv.config();

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
  const run = async () => {
    const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017/beginso";
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
