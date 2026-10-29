import "dotenv/config";
import mongoose from "mongoose";
import app from "./app";
import connectDB from "./config/database";
import { startBackgroundJobs } from "./services/backgroundJobs";
import { createShutdown } from "./utils/gracefulShutdown";

if (!process.env.JWT_SECRET) {
    console.error("❌ JWT_SECRET environment variable is missing. Refusing to start.");
    process.exit(1);
}

if (process.env.NODE_ENV === "production" && !process.env.MONGODB_URI) {
    console.error("❌ MONGODB_URI environment variable is missing in production. Refusing to start.");
    process.exit(1);
}

const PORT = process.env.PORT || 5000;

// One bad fire-and-forget promise must not kill every tenant's requests silently, and a real crash
// must exit so PM2 restarts a clean process.
process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (error) => {
    console.error("Uncaught exception, exiting:", error);
    process.exit(1);
});

const startServer = async () => {
    try {
        await connectDB();

        // Close expired forms, purge Trash, reconcile storage, recover the report queue, sync one collection's indexes.
        // BACKGROUND_JOBS=off turns all of it off (default on): see services/backgroundJobs.ts.
        startBackgroundJobs();

        const server = app.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
        });

        // PM2 and Docker send SIGTERM on restart/deploy: stop taking requests, let in-flight ones finish (up to 25 s), close the
        // database connection, then exit 0.
        const shutdown = createShutdown(server, { closeDb: () => mongoose.connection.close() });
        process.on("SIGTERM", () => void shutdown("SIGTERM"));
        process.on("SIGINT", () => void shutdown("SIGINT"));
    } catch (error) {
        console.error("Server failed to start", error);
        process.exit(1);
    }
};

startServer();
