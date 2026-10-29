import "dotenv/config";
import mongoose from "mongoose";
import app from "./app";
import connectDB from "./config/database";
import EmailVerification from "./models/EmailVerification";
import { closeExpiredForms } from "./services/form.service";
import { recoverReportQueue } from "./services/reportQueue";
import { purgeExpiredTrash } from "./services/trash.service";
import { reconcileAllStorage } from "./services/storage.service";
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

        // The email-verification collection changed shape once (a link became a code), and Mongoose never drops an index the schema no
        // longer has: a leftover UNIQUE index on the old field made every request after the first fail with a duplicate-key error (11000).
        // syncIndexes() makes this one collection's indexes match the schema again. It touches only this collection and is idempotent.
        await EmailVerification.syncIndexes().catch((e) => console.error("EmailVerification.syncIndexes failed:", e));

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

        // B-14: byte-level drift in the per-user storage counter is corrected once a day (first run 10 minutes after
        // start, so a restart does not add load). Every mismatch is logged by reconcileUser. 0 hours turns it off.
        const reconcileHours = Number(process.env.STORAGE_RECONCILE_INTERVAL_HOURS ?? 24);
        if (reconcileHours > 0) {
            const reconcile = () =>
                reconcileAllStorage()
                    .then((rs) => console.log(`[storage] reconcile: ${rs.length} checked, ${rs.filter((r) => r.fixed).length} corrected, ${rs.filter((r) => r.skipped).length} skipped`))
                    .catch((e) => console.error("reconcileAllStorage failed:", e));
            setTimeout(() => {
                reconcile();
                setInterval(reconcile, reconcileHours * 60 * 60 * 1000).unref();
            }, 10 * 60 * 1000).unref();
        }

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
