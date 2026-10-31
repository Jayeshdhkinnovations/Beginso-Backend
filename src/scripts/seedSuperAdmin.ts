import "./_bootstrapGuard"; // must stay the first import: stops the script before anything else loads
import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "../models/User";
import Workspace from "../models/Workspace";
import { auth } from "../config/firebase";
import { SystemLog } from "../models/SystemLog";

dotenv.config();

const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/onboarding";

const seedSuperAdmin = async () => {
  try {
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB for seeding Super Admin");

    const emailsStr = process.env.SUPER_ADMIN_EMAILS;
    if (!emailsStr) {
      console.error("❌ SUPER_ADMIN_EMAILS env variable is not defined");
      process.exit(1);
    }

    const emails = emailsStr.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    const password = process.env.SUPER_ADMIN_PASSWORD;

    for (const email of emails) {
      let firebaseUid = `super-admin-uid-${Buffer.from(email).toString("hex").substring(0, 15)}`;

      // Try to create/update Firebase User if password is provided
      if (password) {
        try {
          const fbUser = await auth.createUser({
            email,
            password,
            displayName: "Super Admin",
            emailVerified: true,
          });
          firebaseUid = fbUser.uid;
          console.log(`🔥 Created Firebase user for Super Admin: ${email}`);
        } catch (fbErr: any) {
          if (fbErr.code === "auth/email-already-exists") {
            const fbUser = await auth.getUserByEmail(email);
            firebaseUid = fbUser.uid;
            await auth.updateUser(firebaseUid, { password, emailVerified: true });
            console.log(`🔥 Updated Firebase password and emailVerified for Super Admin: ${email}`);
          } else {
            console.warn(`⚠️ Firebase Admin SDK error (using fallback UID):`, fbErr.message);
          }
        }
      } else {
        console.log("ℹ️ No SUPER_ADMIN_PASSWORD provided; skipping Firebase Auth synchronization");
      }

      let user = await User.findOne({ email });
      if (user) {
        user.role = "super_admin";
        user.status = "active";
        user.firebaseUid = firebaseUid;
        await user.save();
        console.log(`🚀 Promoted existing user to Super Admin: ${email}`);
      } else {
        // Create a new Super Admin user
        user = await User.create({
          fullName: "Super Admin",
          email,
          firebaseUid,
          role: "super_admin",
          status: "active",
        });
        console.log(`✨ Created new Super Admin user in DB: ${email}`);
      }

      // Ensure they have a Workspace
      let workspace = await Workspace.findOne({ owner: user._id });
      if (!workspace) {
        workspace = await Workspace.create({
          name: "Super Admin Workspace",
          owner: user._id,
        });
        user.workspaceId = workspace._id as any;
        await user.save();
        console.log(`📁 Created workspace for Super Admin: ${email}`);
      }
    }

    // Seed mock system logs if the collection is empty
    const logCount = await SystemLog.countDocuments();
    if (logCount === 0) {
      console.log("📝 Seeding mock system logs for the logs viewer...");
      const mockLogs = [
        {
          level: "info",
          message: "Database connected successfully",
          route: "system",
          statusCode: 200,
          createdAt: new Date(Date.now() - 4 * 3600000),
        },
        {
          level: "info",
          message: "Firebase Admin SDK initialized",
          route: "system",
          statusCode: 200,
          createdAt: new Date(Date.now() - 3.5 * 3600000),
        },
        {
          level: "info",
          message: "App started on port 5000",
          route: "system",
          statusCode: 200,
          createdAt: new Date(Date.now() - 3 * 3600000),
        },
        {
          level: "warn",
          message: "Rate limit threshold reached for IP: 7f9208a0db1490ae",
          route: "/api/public/job-application/submit",
          statusCode: 429,
          meta: { type: "rate_limit", ipHash: "7f9208a0db1490ae", slug: "job-application" },
          createdAt: new Date(Date.now() - 2.5 * 3600000),
        },
        {
          level: "warn",
          message: "Honeypot silent drop triggered",
          route: "/api/public/feedback-form/submit",
          statusCode: 200,
          meta: { type: "honeypot_drop", ipHash: "bf92e8a0db1490ce", slug: "feedback-form" },
          createdAt: new Date(Date.now() - 2 * 3600000),
        },
        {
          level: "error",
          message: "Failed to upload file: Disk full or write permission denied",
          route: "/api/upload",
          statusCode: 500,
          meta: { path: "uploads/resume.pdf", errorDetails: "ENOSPC: no space left on device" },
          stack: "Error: ENOSPC: no space left on device\n    at Object.writeSync (fs.js:570:3)\n    at writeFileSync (fs.js:1455:21)",
          createdAt: new Date(Date.now() - 1.5 * 3600000),
        },
        {
          level: "info",
          message: "Template loaded: feedback_form",
          route: "/api/templates",
          statusCode: 200,
          createdAt: new Date(Date.now() - 1 * 3600000),
        },
        {
          level: "error",
          message: "Validation failed: Required field 'email' is missing",
          route: "/api/public/contact-us/submit",
          statusCode: 422,
          meta: { errors: [{ field: "email", message: "Field 'email' is required." }] },
          createdAt: new Date(Date.now() - 0.5 * 3600000),
        },
      ];
      await SystemLog.insertMany(mockLogs);
      console.log("✅ Seeded 8 mock system logs successfully!");
    }

    console.log("✅ Super Admin seeding completed successfully");
    await mongoose.disconnect();
  } catch (error) {
    console.error("❌ Error seeding Super Admin:", error);
    process.exit(1);
  }
};

seedSuperAdmin();
