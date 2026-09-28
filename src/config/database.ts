import mongoose from "mongoose";

const connectDB = async (): Promise<void> => {
    try {
        const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/onboarding";
        if (!process.env.MONGODB_URI) {
            console.warn("⚠️ MONGODB_URI environment variable is missing. Falling back to local MongoDB: mongodb://127.0.0.1:27017/onboarding");
        }
        mongoose.connection.on("error", (err) => console.error("MongoDB connection error:", err));
        mongoose.connection.on("disconnected", () => console.warn("MongoDB disconnected"));
        await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000, socketTimeoutMS: 45000 });

        console.log("✅ MongoDB Connected Successfully");
    } catch (error) {
        console.error("❌ MongoDB Connection Failed");

        console.error(error);

        process.exit(1);
    }
};

export default connectDB;