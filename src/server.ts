import "dotenv/config";
import app from "./app";
import connectDB from "./config/database";
import { closeExpiredForms } from "./services/form.service";
import { recoverReportQueue } from "./services/reportQueue";
import { purgeExpiredTrash } from "./services/trash.service";

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

        // Close forms whose close date has passed: once now, then every 5 minutes.
        const sweep = () => closeExpiredForms().catch((e) => console.error("closeExpiredForms failed:", e));
        sweep();
        recoverReportQueue().catch((e) => console.error("recoverReportQueue failed:", e));
        setInterval(sweep, 5 * 60 * 1000).unref();

        // Sprint 13 (CF5.5): permanently remove anything that has sat in Trash for 30 days. Same cadence as
        // the sweep above; bounded per run and idempotent, so it is safe on several instances at once.
        const retention = () => purgeExpiredTrash().catch((e) => console.error("purgeExpiredTrash failed:", e));
        retention();
        setInterval(retention, 5 * 60 * 1000).unref();

        const server = app.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
        });

        // PM2 sends SIGTERM on restart/deploy: stop taking requests, let in-flight ones finish.
        const shutdown = (signal: string) => {
            console.log(`${signal} received, shutting down`);
            server.close(() => process.exit(0));
            setTimeout(() => process.exit(0), 10000).unref();
        };
        process.on("SIGTERM", () => shutdown("SIGTERM"));
        process.on("SIGINT", () => shutdown("SIGINT"));
    } catch (error) {
        console.error("Server failed to start", error);
        process.exit(1);
    }
};

startServer();
