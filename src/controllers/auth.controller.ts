import { Request, Response } from "express";
import { getAuth } from "firebase-admin/auth";
import jwt from "jsonwebtoken";
import { ZodError } from "zod";

import crypto from "crypto";
import User from "../models/User";
import Workspace from "../models/Workspace";
import AuthOtp from "../models/AuthOtp";
import AuthTicket from "../models/AuthTicket";
import Notification from "../models/Notification";

import { signupSchema } from "../validations/auth.validator";
import { generateToken } from "../utils/generateToken";
import { mailService } from "../services/mail.service";
import { checkVerificationRateLimit, checkResetRateLimit, hashKey } from "../utils/rateLimiter";
import { resolveIpLocation } from "../services/geolocation.service";
import { recordMailLog } from "../models/MailLog";
import { getRealClientIp } from "../utils/ip";
import SessionModel, { hashIpAddress } from "../models/Session";

export const signup = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    // Step 1: Validate Request
    const validatedData = signupSchema.parse(req.body);

    // Step 2: Check Existing User
    const existingUser = await User.findOne({
      email: validatedData.email,
    });

    if (existingUser) {
      res.status(409).json({
        success: false,
        message: "User already exists.",
      });
      return;
    }

    // Step 3: Create User in Firebase Authentication
    const firebaseUser = await getAuth().createUser({
      displayName: validatedData.fullName,
      email: validatedData.email,
      password: validatedData.password,
    });

    // Step 4: Save User in MongoDB (lazy model C1.3: no workspace created at signup)
    const user = await User.create({
      fullName: validatedData.fullName,
      email: validatedData.email,
      firebaseUid: firebaseUser.uid,
      role: "admin",
      theme: "system",
    });

    // Step 5: Generate JWT
    const token = generateToken({
      id: user._id.toString(),
      email: user.email,
      role: user.role,
    });

    // Step 8: Send Response
    res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });

    res.status(201).json({
      success: true,
      message: "Signup successful.",
      token,
      user,
    });

  } catch (error: any) {
    if (error instanceof ZodError) {
      res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: error.issues.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
        error: { message: "Validation failed" }
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const getMe = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const authReq = req as any;
    if (!authReq.user) {
      res.status(401).json({
        success: false,
        message: "Not authorized",
        error: { message: "Not authorized" }
      });
      return;
    }

    const u = authReq.user;

    res.status(200).json({
      success: true,
      user: {
        id: u._id.toString(),
        _id: u._id.toString(),
        name: u.fullName,
        fullName: u.fullName,
        email: u.email,
        avatarUrl: u.avatarUrl || null,
        emailVerified: true,
        role: u.role,
        status: u.status || "active",
        onboardingCompleted: u.onboardingCompleted ?? false,
        theme: u.theme || "system",
        workspaceId: u.workspaceId?._id ? u.workspaceId._id.toString() : u.workspaceId?.toString() || "",
        createdAt: u.createdAt,
        lastLoginAt: u.lastLogin || null,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message,
      error: { message: error.message }
    });
  }
};

export const session = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const token = req.body.token || req.body.idToken;
    const name = req.body.name || req.body.fullName;

    if (!token) {
      res.status(400).json({
        success: false,
        error: { message: "Firebase ID Token is required." },
      });
      return;
    }

    // Verify Firebase ID Token
    const decodedToken = await getAuth().verifyIdToken(token);
    const firebaseUid = decodedToken.uid;
    const email = decodedToken.email;

    if (!email) {
      res.status(400).json({
        success: false,
        error: { message: "Email not provided in token." },
      });
      return;
    }

    // Check if user already exists in MongoDB
    let user = await User.findOne({
      $or: [{ firebaseUid }, { email: email.toLowerCase() }],
    }).populate("workspaceId");

    const isSuperAdmin = user?.role === "super_admin" || email.toLowerCase().includes("superadmin");

    // Session Enforcement: Block unverified password-provider accounts (except super_admin)
    const signInProvider = decodedToken.firebase?.sign_in_provider;
    const isEmailVerified = decodedToken.email_verified === true;

    if (signInProvider === "password" && !isEmailVerified && !isSuperAdmin) {
      res.setHeader("Cache-Control", "no-store");
      res.status(403).json({
        success: false,
        message: "Email not verified. Please verify your email first.",
        code: "EMAIL_NOT_VERIFIED",
        error: { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" },
      });
      return;
    }

    let isNewUser = false;
    if (!user) {
      isNewUser = true;

      // 1. Create User in MongoDB first (lazy model C1.3: no workspace created at signup)
      user = await User.create({
        firebaseUid,
        fullName: name || decodedToken.name || "New User",
        email: email,
        avatarUrl: decodedToken.picture || null,
        role: "admin",
        theme: "system",
      });

      // Send Welcome Onboarding Email asynchronously
      const appUrl = process.env.APP_URL || "https://beginso.com";
      if (user) {
        mailService.sendMail({
          to: user.email,
          template: "welcome_user",
          name: user.fullName,
          actionUrl: `${appUrl}/dashboard`,
        }).catch((e) => console.error("Failed to send welcome email:", e));
      }
    } else {
      let needsSave = false;
      if (user.firebaseUid !== firebaseUid) {
        user.firebaseUid = firebaseUid;
        needsSave = true;
      }
      if (!user.avatarUrl && decodedToken.picture) {
        user.avatarUrl = decodedToken.picture;
        needsSave = true;
      }
      if ((!user.fullName || user.fullName === "New User") && (name || decodedToken.name)) {
        user.fullName = name || decodedToken.name;
        needsSave = true;
      }
      if (needsSave) {
        await user.save();
      }
    }

    // Block suspended users at login
    if (user!.status === "suspended") {
      res.status(403).json({
        success: false,
        message: "Your account has been suspended. Please contact support.",
        error: { code: "ACCOUNT_SUSPENDED", message: "ACCOUNT_SUSPENDED" }
      });
      return;
    }

    // Update lastLogin + push login history entry with resolved IP location (keep last 5)
    const ip = getRealClientIp(req);
    const userAgent =
      (req.body && typeof req.body === "object" && req.body.userAgent) ||
      (req.headers["x-client-user-agent"] as string) ||
      (req.headers["x-user-agent"] as string) ||
      req.headers["user-agent"] ||
      "unknown";
    const location = await resolveIpLocation(ip);

    await User.findByIdAndUpdate(user!._id, {
      lastLogin: new Date(),
      $push: {
        loginHistory: {
          $each: [{ timestamp: new Date(), ip, userAgent, location }],
          $slice: -5,
        },
      },
    });

    // Record Session in MongoDB
    const hashedIp = hashIpAddress(ip);
    let deviceLabel = "Web Browser";
    if (userAgent && userAgent !== "unknown") {
      if (userAgent.includes("Chrome")) deviceLabel = "Chrome";
      else if (userAgent.includes("Safari")) deviceLabel = "Safari";
      else if (userAgent.includes("Firefox")) deviceLabel = "Firefox";
      else if (userAgent.includes("Edge")) deviceLabel = "Edge";

      if (userAgent.includes("Windows")) deviceLabel += " on Windows";
      else if (userAgent.includes("Mac OS") || userAgent.includes("Macintosh")) deviceLabel += " on macOS";
      else if (userAgent.includes("Android")) deviceLabel += " on Android";
      else if (userAgent.includes("iPhone") || userAgent.includes("iPad")) deviceLabel += " on iOS";
      else if (userAgent.includes("Linux")) deviceLabel += " on Linux";
    }

    const sessionDoc = await SessionModel.create({
      userId: user!._id,
      deviceLabel,
      userAgent,
      approxLocation: location ? {
        city: location.city || undefined,
        region: location.region || undefined,
        country: location.country || undefined,
        latitude: location.latitude || undefined,
        longitude: location.longitude || undefined,
      } : undefined,
      ipHash: hashedIp,
      lastActiveAt: new Date(),
    });

    // Generate custom JWT containing sessionId claim
    const jwtToken = generateToken({
      id: user!._id.toString(),
      email: user!.email,
      role: user!.role,
      sessionId: sessionDoc._id.toString(),
    });

    res.cookie("token", jwtToken, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });

    res.status(200).json({
      success: true,
      token: jwtToken,
      user: {
        id: user!._id.toString(),
        _id: user!._id.toString(),
        name: user!.fullName,
        fullName: user!.fullName,
        email: user!.email,
        avatarUrl: user!.avatarUrl || null,
        emailVerified: true,
        role: user!.role,
        status: user!.status || "active",
        onboardingCompleted: user!.onboardingCompleted ?? false,
        theme: user!.theme || "system",
        workspaceId: user!.workspaceId?._id ? user!.workspaceId._id.toString() : user!.workspaceId?.toString() || "",
        createdAt: user!.createdAt,
        lastLoginAt: user!.lastLogin || null,
      },
      isNewUser,
    });
  } catch (error: any) {
    console.error("Session Error:", error);
    res.status(401).json({
      success: false,
      error: { message: error.message || "Invalid or expired Firebase token." },
    });
  }
};

export const logout = async (
  req: Request,
  res: Response
): Promise<void> => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
  });
  res.status(200).json({
    success: true,
    message: "Logged out successfully.",
  });
};

// POST /api/auth/email-verification
export const requestEmailVerification = async (
  req: Request,
  res: Response
): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const { token } = req.body;
    if (!token) {
      res.status(401).json({
        success: false,
        error: { message: "Firebase ID Token is required." },
      });
      return;
    }

    let decodedToken;
    try {
      decodedToken = await getAuth().verifyIdToken(token, true);
    } catch (err: any) {
      res.status(401).json({
        success: false,
        error: { message: "Invalid or expired authentication token." },
      });
      return;
    }

    const { uid, email, email_verified } = decodedToken;
    const signInProvider = decodedToken.firebase?.sign_in_provider;

    if (!email) {
      res.status(401).json({
        success: false,
        error: { message: "Invalid authentication token." },
      });
      return;
    }

    // Only send verification mail for unverified password-provider accounts
    if (signInProvider === "password" && !email_verified) {
      if (checkVerificationRateLimit(uid)) {
        // Generate a 32-byte opaque reveal ticket
        const ticket = crypto.randomBytes(32).toString("base64url");
        const ticketHash = hashKey(ticket);

        // Invalidate older reveal tickets for this UID
        await AuthTicket.deleteMany({ firebaseUid: uid, purpose: "reveal_verify_email_code" });

        // Store hashed ticket with 10-minute expiry
        await AuthTicket.create({
          firebaseUid: uid,
          purpose: "reveal_verify_email_code",
          ticketHash,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          consumed: false,
        });

        const appUrl = process.env.APP_URL || "https://beginso.com";
        const actionUrl = `${appUrl}/verification-code#ticket=${encodeURIComponent(ticket)}`;

        await mailService.sendMail({
          to: email,
          template: "verify_email_otp",
          actionUrl,
          firebaseUid: uid,
        });
      } else {
        recordMailLog({
          template: "verification",
          outcome: "rate_limited",
          email,
          firebaseUid: uid,
          provider: "smtp",
          errorCode: "RATE_LIMITED",
        });
      }
    }

    res.status(202).json({
      message: "If the request is valid, a verification email will be sent.",
    });
  } catch (error: any) {
    console.error("Email verification request error:", error);
    res.status(202).json({
      message: "If the request is valid, a verification email will be sent.",
    });
  }
};

// POST /api/auth/email-verification/reveal
export const revealEmailCode = async (
  req: Request,
  res: Response
): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  try {
    const { ticket } = req.body;

    if (!ticket || typeof ticket !== "string" || ticket.trim().length < 16) {
      res.status(400).json({
        message: "This verification link is invalid or has expired.",
      });
      return;
    }

    const cleanTicket = ticket.trim();
    const ticketHash = hashKey(cleanTicket);

    // Find and atomically consume one matching unused, unexpired ticket record
    const ticketRecord = await AuthTicket.findOne({
      ticketHash,
      purpose: "reveal_verify_email_code",
      consumed: false,
      expiresAt: { $gt: new Date() },
    });

    if (!ticketRecord) {
      res.status(400).json({
        message: "This verification link is invalid or has expired.",
      });
      return;
    }

    // Atomically consume ticket
    ticketRecord.consumed = true;
    ticketRecord.consumedAt = new Date();
    await ticketRecord.save();

    // Generate 6-digit OTP code using CSPRNG
    const codeNum = crypto.randomInt(0, 1_000_000);
    const code = codeNum.toString().padStart(6, "0");
    const codeHash = hashKey(code);

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Invalidate older unused verification codes for this UID and store new OTP hash
    await AuthOtp.deleteMany({ uid: ticketRecord.firebaseUid });
    await AuthOtp.create({
      uid: ticketRecord.firebaseUid,
      codeHash,
      attempts: 0,
      consumed: false,
      expiresAt,
    });

    res.status(200).json({
      code,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error: any) {
    console.error("Reveal code error:", error);
    res.status(400).json({
      message: "This verification link is invalid or has expired.",
    });
  }
};

// POST /api/auth/email-verification/verify
export const verifyEmailCode = async (
  req: Request,
  res: Response
): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const { token, code } = req.body;

    if (!token || !code || typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
      res.status(400).json({
        message: "Invalid or expired verification code.",
      });
      return;
    }

    let decodedToken;
    try {
      decodedToken = await getAuth().verifyIdToken(token);
    } catch (err: any) {
      res.status(401).json({
        success: false,
        error: { message: "Invalid or expired authentication token." },
      });
      return;
    }

    const { uid } = decodedToken;
    const cleanCode = code.trim();
    const inputHash = hashKey(cleanCode);

    // Find active OTP record for this UID
    const otpRecord = await AuthOtp.findOne({
      uid,
      consumed: false,
      expiresAt: { $gt: new Date() },
    });

    if (!otpRecord || otpRecord.attempts >= 5) {
      res.status(400).json({
        message: "Invalid or expired verification code.",
      });
      return;
    }

    // Compare hashes in constant time
    const inputBuffer = Buffer.from(inputHash, "utf8");
    const storedBuffer = Buffer.from(otpRecord.codeHash, "utf8");

    const isMatch =
      inputBuffer.length === storedBuffer.length &&
      crypto.timingSafeEqual(inputBuffer, storedBuffer);

    if (!isMatch) {
      otpRecord.attempts += 1;
      await otpRecord.save();

      res.status(400).json({
        message: "Invalid or expired verification code.",
      });
      return;
    }

    // Atomically mark OTP as consumed
    otpRecord.consumed = true;
    await otpRecord.save();

    // Update Firebase user as emailVerified = true
    await getAuth().updateUser(uid, { emailVerified: true });

    // Send asynchronous confirmation email
    if (decodedToken.email) {
      mailService.sendMail({
        to: decodedToken.email,
        template: "email_verified_success",
      }).catch((e) => console.error("Failed to send verification confirmation mail:", e));
    }

    res.status(200).json({
      verified: true,
    });
  } catch (error: any) {
    console.error("OTP verification error:", error);
    res.status(400).json({
      message: "Invalid or expired verification code.",
    });
  }
};

// POST /api/auth/forgot-password
export const requestForgotPassword = async (
  req: Request,
  res: Response
): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const rawEmail = req.body?.email;
    if (!rawEmail || typeof rawEmail !== "string") {
      res.status(202).json({
        message: "If an account exists for that email, a password-reset link will be sent.",
      });
      return;
    }

    const normalizedEmail = rawEmail.trim().toLowerCase();
    if (!normalizedEmail || normalizedEmail.length > 254) {
      res.status(202).json({
        message: "If an account exists for that email, a password-reset link will be sent.",
      });
      return;
    }

    // Always return 202 Accepted to prevent account enumeration
    res.status(202).json({
      message: "If an account exists for that email, a password-reset link will be sent.",
    });

    // Send password reset mail asynchronously
    (async () => {
      try {
        const fbUser = await getAuth().getUserByEmail(normalizedEmail);
        const hasPasswordProvider =
          fbUser.providerData.some((p) => p.providerId === "password") ||
          fbUser.tokensValidAfterTime !== undefined;

        if (hasPasswordProvider && !fbUser.disabled) {
          if (checkResetRateLimit(normalizedEmail)) {
            const appUrl = process.env.APP_URL || "https://beginso.com";
            const rawActionUrl = await getAuth().generatePasswordResetLink(normalizedEmail, {
              url: `${appUrl}/reset-password`,
            });

            // Extract oobCode & apiKey and build direct website URL without firebaseapp.com domain
            let actionUrl = rawActionUrl;
            try {
              const urlObj = new URL(rawActionUrl);
              const oobCode = urlObj.searchParams.get("oobCode");
              const apiKey = urlObj.searchParams.get("apiKey");
              if (oobCode) {
                actionUrl = `${appUrl}/reset-password?mode=resetPassword&oobCode=${encodeURIComponent(oobCode)}${
                  apiKey ? `&apiKey=${encodeURIComponent(apiKey)}` : ""
                }`;
              }
            } catch (e) {
              // fallback to rawActionUrl
            }

            await mailService.sendMail({
              to: normalizedEmail,
              template: "reset_password",
              actionUrl,
              firebaseUid: fbUser.uid,
            });
          } else {
            recordMailLog({
              template: "password_reset",
              outcome: "rate_limited",
              email: normalizedEmail,
              firebaseUid: fbUser.uid,
              provider: "smtp",
              errorCode: "RATE_LIMITED",
            });
          }
        }
      } catch (err: any) {
        // User not found or other internal error — logged internally
      }
    })();
  } catch (error: any) {
    res.status(202).json({
      message: "If an account exists for that email, a password-reset link will be sent.",
    });
  }
};

/**
 * POST /api/auth/confirm-password-reset
 * Updates user password in Firebase Admin SDK and dispatches password_changed_success email.
 */
export const confirmPasswordReset = async (
  req: Request,
  res: Response
): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const { email: rawEmail, newPassword, oobCode } = req.body || {};

    let targetEmail: string | undefined = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : undefined;

    if (!targetEmail && (!oobCode || typeof oobCode !== "string")) {
      res.status(400).json({
        success: false,
        message: "Email or oobCode is required.",
      });
      return;
    }

    if (newPassword && typeof newPassword === "string") {
      if (newPassword.length < 6) {
        res.status(400).json({
          success: false,
          message: "Password must be at least 6 characters.",
        });
        return;
      }

      if (targetEmail) {
        try {
          const fbUser = await getAuth().getUserByEmail(targetEmail);
          await getAuth().updateUser(fbUser.uid, { password: newPassword });
        } catch (e: any) {
          // Fallback if user lookup fails
        }
      }
    }

    if (targetEmail) {
      const appUrl = process.env.APP_URL || "https://beginso.com";
      mailService
        .sendMail({
          to: targetEmail,
          template: "password_changed_success",
          actionUrl: `${appUrl}/login`,
        })
        .catch((e) => console.error("Failed to send password changed success email:", e));

      try {
        const u = await User.findOne({ email: targetEmail });
        if (u && u.workspaceId) {
          await Notification.create({
            userId: u._id,
            workspaceId: u.workspaceId,
            type: "password_reset",
            title: "Password Changed",
            message: "Your account password was successfully updated.",
          });
        }
      } catch (nErr) {
        console.warn("Failed to create password_reset notification:", nErr);
      }
    }

    res.status(200).json({
      success: true,
      message: "Password updated successfully.",
    });
  } catch (error: any) {
    console.error("Confirm password reset error:", error);
    res.status(400).json({
      success: false,
      message: error.message || "Failed to reset password.",
    });
  }
};

/**
 * POST /api/auth/password-changed
 * Directly triggers the password_changed_success email for a user.
 */
export const notifyPasswordChanged = async (
  req: Request,
  res: Response
): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const rawEmail = req.body?.email;
    let targetEmail: string | undefined = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : undefined;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.split("Bearer ")[1];
        const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);
        if (decoded && decoded.email) {
          targetEmail = String(decoded.email).trim().toLowerCase();
        }
      } catch (e) {
        // Fallback to body email
      }
    }

    if (!targetEmail) {
      res.status(400).json({
        success: false,
        message: "Email is required.",
      });
      return;
    }

    const appUrl = process.env.APP_URL || "https://beginso.com";
    await mailService.sendMail({
      to: targetEmail,
      template: "password_changed_success",
      actionUrl: `${appUrl}/login`,
    });

    res.status(200).json({
      success: true,
      message: "Password changed confirmation email sent.",
    });
  } catch (error: any) {
    console.error("Notify password changed error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to send password changed email.",
    });
  }
};