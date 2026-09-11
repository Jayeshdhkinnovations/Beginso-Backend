import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import healthRoutes from "./routes/health.routes";
import testRoutes from "./routes/test.routes";
import authRoutes from "./routes/auth.routes";
import userRoutes from "./routes/user.routes";
import workspaceRoutes from "./routes/workspace.routes";
import formRoutes from "./routes/form.routes";
import dashboardRoutes from "./routes/dashboard.routes";
import uploadRoutes from "./routes/upload.routes";
import templateRoutes from "./routes/template.routes";
import publicRoutes from "./routes/public.routes";
import responseRoutes from "./routes/response.routes";
import superadminRoutes from "./routes/superadmin.routes";
import analyticsRoutes from "./routes/analytics.routes";
import reportRoutes from "./routes/report.routes";
import notificationRoutes from "./routes/notification.routes";
import invitationRoutes from "./routes/invitation.routes";
import sharedWithMeRoutes from "./routes/shared_with_me.routes";
import { errorHandler } from "./middleware/error.middleware";

// Continuous Deployment Test Comment
const app = express();
app.set("trust proxy", true);

const defaultAllowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5000",
  "https://beginso.com",
  "https://app.beginso.com",
  "https://admin.beginso.com",
  "https://www.beginso.com",
];

const envAllowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : [];

const allowedOrigins = Array.from(new Set([...defaultAllowedOrigins, ...envAllowedOrigins]));

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (server-to-server, curl, mobile, same-origin)
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // Dynamically allow any *.beginso.com, *.dhkinnovations.com, or *.vercel.app domain
      if (
        /^https:\/\/([a-zA-Z0-9-]+\.)*beginso\.com$/.test(origin) ||
        /^https:\/\/([a-zA-Z0-9-]+\.)*dhkinnovations\.com$/.test(origin) ||
        /^https:\/\/([a-zA-Z0-9-]+\.)*vercel\.app$/.test(origin)
      ) {
        return callback(null, true);
      }

      // Return false so CORS rejects origin cleanly without 500 error
      callback(null, false);
    },
    credentials: true,
  })
);
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: { policy: "unsafe-none" }
}));
app.use(express.json());
app.use(morgan("dev"));

// Test comment to trigger CD self-hosted deployment verification
app.get("/", (req, res) => {
    res.json({
        message: "Backend Running Successfully"
    });
});
app.use("/api/test", testRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/workspaces", workspaceRoutes);
app.use("/api/forms", formRoutes);
app.use("/api/responses", responseRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/superadmin", superadminRoutes);
app.use("/api/invitations", invitationRoutes);
app.use("/api/shared-with-me", sharedWithMeRoutes);
app.use("/api", healthRoutes);

app.use(errorHandler as any);

export default app;
