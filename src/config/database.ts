import mongoose from "mongoose";

/**
 * Runs `connect` until it works, at most `attempts` times with `delayMs` between tries, and throws the last error if none does.
 * Starting up on a network that drops for a few seconds (a DNS hiccup, Wi-Fi, a VPN switching) used to end the whole process on the
 * first failed try; now it waits and tries again, and only gives up when the database really is out of reach.
 */
export const connectWithRetry = async (
    connect: () => Promise<unknown>,
    attempts: number,
    delayMs: number,
    onRetry: (attempt: number, error: unknown) => void = () => {}
): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
        try {
            await connect();
            return;
        } catch (error) {
            if (attempt >= attempts) throw error;
            onRetry(attempt, error);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
};

const connectDB = async (): Promise<void> => {
    try {
        const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/onboarding";
        if (!process.env.MONGODB_URI) {
            console.warn("⚠️ MONGODB_URI environment variable is missing. Falling back to local MongoDB: mongodb://127.0.0.1:27017/onboarding");
        }
        mongoose.connection.on("error", (err) => console.error("MongoDB connection error:", err));
        mongoose.connection.on("disconnected", () => console.warn("MongoDB disconnected"));
        // Up to about two and a half minutes of trying (10 tries, each waiting up to 10s for a server, 5s apart): a network that drops for a
        // minute or two (office DNS or Wi-Fi) is waited out. DB_CONNECT_ATTEMPTS and DB_CONNECT_RETRY_MS change it.
        const attempts = Number(process.env.DB_CONNECT_ATTEMPTS) || 10;
        const delayMs = Number(process.env.DB_CONNECT_RETRY_MS) || 5000;
        await connectWithRetry(
            () => mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000, socketTimeoutMS: 45000 }),
            attempts,
            delayMs,
            (attempt) => console.warn(`⚠️ MongoDB not reachable (try ${attempt} of ${attempts}); trying again in ${Math.round(delayMs / 1000)}s`)
        );

        console.log("✅ MongoDB Connected Successfully");
    } catch (error) {
        console.error("❌ MongoDB Connection Failed");

        console.error(error);

        process.exit(1);
    }
};

export default connectDB;
