import "dotenv/config";
import app from "./app";
import connectDB from "./config/database";

if (!process.env.JWT_SECRET) {
    console.error("❌ JWT_SECRET environment variable is missing. Refusing to start.");
    process.exit(1);
}

if (process.env.NODE_ENV === "production" && !process.env.MONGODB_URI) {
    console.error("❌ MONGODB_URI environment variable is missing in production. Refusing to start.");
    process.exit(1);
}

const PORT = process.env.PORT || 5000;

const startServer = async () => {
    try {
        await connectDB();

        app.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
        });
    } catch (error) {
        console.error("Server failed to start", error);
        process.exit(1);
    }
};

startServer();
