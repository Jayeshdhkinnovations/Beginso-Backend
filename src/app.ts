import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import healthRoutes from "./routes/health.routes";
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
import searchRoutes from "./routes/search.routes";
import invitationRoutes from "./routes/invitation.routes";
import sharedWithMeRoutes from "./routes/shared_with_me.routes";
import savedViewRoutes from "./routes/savedView.routes";
import trashRoutes from "./routes/trash.routes";
import respondRoutes from "./routes/respond.routes";
import mySubmissionsRoutes from "./routes/mySubmissions.routes";
import { errorHandler } from "./middleware/error.middleware";
import { normalizeErrorShape } from "./middleware/errorShape.middleware";
import { buildInfo, describeBuild } from "./utils/buildInfo";

// Continuous Deployment Test Comment
const app = express();
// Number of reverse proxies in front of this process (nginx = 1, Cloudflare + nginx = 2, none = 0).
// With `true` any caller could choose their own IP by sending X-Forwarded-For.
const proxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? "1", 10);
app.set("trust proxy", Number.isFinite(proxyHops) && proxyHops >= 0 ? proxyHops : 1);

// Browsers only call this API directly from these origins: the public form (beginso.com,
// beginso.vercel.app) and the admin console. The main app goes through its own same-origin proxy, which sends no Origin header.
// Exact origins only: no wildcard subdomains, so no other vercel.app or dhkinnovations.com
// site can never make credentialed requests. Extra origins (staging) go in CORS_ORIGINS.
const productionOrigins = [
  "https://beginso.com", // the real frontend and the public form
  "https://www.beginso.com",
  "https://admin.beginso.com", // super-admin console
  "https://beginso.vercel.app", // Vercel deployment of the frontend
];
const developmentOrigins = ["http://localhost:3000", "http://localhost:3001", "http://localhost:5000"];

const envAllowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : [];

const allowedOrigins = new Set([
  ...productionOrigins,
  ...(process.env.NODE_ENV === "production" ? [] : developmentOrigins),
  ...envAllowedOrigins,
]);

app.use(
  cors({
    origin: (origin, callback) => {
      // No Origin header: server-to-server (the frontend proxy), curl, health checks.
      if (!origin) return callback(null, true);
      // false makes CORS reject the origin cleanly, without a 500.
      callback(null, allowedOrigins.has(origin));
    },
    credentials: true,
  })
);
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: { policy: "unsafe-none" }
}));
app.use(express.json());
app.use(normalizeErrorShape);
if (process.env.NODE_ENV !== "test") {
  app.use(morgan("dev"));
}

// Test comment to trigger CD self-hosted deployment verification
app.get("/", (req, res) => {
    res.json({
        message: `Backend Running Successfully (${describeBuild(buildInfo)})`,
        ...buildInfo
    });
});
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
app.use("/api/search", searchRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/superadmin", superadminRoutes);
app.use("/api/invitations", invitationRoutes);
app.use("/api/shared-with-me", sharedWithMeRoutes);
app.use("/api/views", savedViewRoutes);
// Sprint 13
app.use("/api/trash", trashRoutes);
app.use("/api/respond", respondRoutes);
app.use("/api/my-submissions", mySubmissionsRoutes);
app.use("/api", healthRoutes);

app.use(errorHandler as any);

export default app;
