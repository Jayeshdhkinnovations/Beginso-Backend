import nodemailer from "nodemailer";
import crypto from "crypto";
import { recordMailLog } from "../models/MailLog";

export type AuthMailType =
  | "verify_email"
  | "verify_email_otp"
  | "reset_password"
  | "welcome_user"
  | "email_verified_success"
  | "password_changed_success"
  | "workspace_invitation";

export interface SendMailOptions {
  to: string;
  template: AuthMailType;
  actionUrl?: string;
  code?: string;
  name?: string;
  firebaseUid?: string;
  requestId?: string;
  workspaceName?: string;
  inviterName?: string;
  role?: string;
}

class MailService {
  private transporter: nodemailer.Transporter | null = null;

  private getTransporter(): nodemailer.Transporter {
    if (!this.transporter) {
      const host = process.env.SMTP_HOST || "email.toowix.com";
      const port = Number(process.env.SMTP_PORT) || 587;
      const secure = process.env.SMTP_SECURE === "true";
      const user = process.env.SMTP_USER || "";
      const pass = process.env.SMTP_PASS || "";

      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: user && pass ? { user, pass } : undefined,
        tls: {
          rejectUnauthorized: false,
        },
      });
    }
    return this.transporter;
  }

  async sendMail(options: SendMailOptions): Promise<void> {
    const startTime = Date.now();
    const reqId = options.requestId || `req_${crypto.randomBytes(8).toString("hex")}`;
    const fromName = process.env.SMTP_FROM_NAME || "Beginso";
    const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || "no-reply@beginso.com";
    const from = `"${fromName}" <${fromEmail}>`;
    const appUrl = process.env.APP_URL || "https://beginso.com";

    const { to, template, actionUrl, code, name, firebaseUid, workspaceName, inviterName, role } = options;

    let mappedLogTemplate: "verification" | "password_reset" | "welcome" | null = null;
    if (template === "verify_email" || template === "verify_email_otp") {
      mappedLogTemplate = "verification";
    } else if (template === "reset_password") {
      mappedLogTemplate = "password_reset";
    } else if (template === "welcome_user" || template === "workspace_invitation") {
      mappedLogTemplate = "welcome";
    }

    let subject = "";
    let htmlContent = "";
    let textContent = "";

    if (template === "verify_email" || template === "verify_email_otp") {
      subject = "Verify your Beginso email";
      const revealUrl = actionUrl || `${appUrl}/verification-code`;

      textContent = `Verify your email address\n\nClick the link below to securely view your six-digit verification code:\n\n${revealUrl}\n\nThis secure link and its verification code expire in 10 minutes.\n\nIf you did not create a Beginso account, ignore this email.`;

      htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${subject}</title>
        </head>
        <body style="margin: 0; padding: 0; background-color: #F3F4F6; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #F3F4F6; padding: 40px 16px;">
            <tr>
              <td align="center">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 540px; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #E5E7EB; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05), 0 8px 10px -6px rgba(0,0,0,0.01);">
                  <!-- Header Gradient Bar -->
                  <tr>
                    <td style="background: linear-gradient(135deg, #1E40AF 0%, #3B82F6 100%); height: 8px;"></td>
                  </tr>
                  
                  <!-- Main Content Area -->
                  <tr>
                    <td style="padding: 40px 36px 36px 36px;">
                      <!-- Logo -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 28px;">
                        <tr>
                          <td>
                            <span style="font-size: 26px; font-weight: 800; color: #1E40AF; letter-spacing: -0.8px; display: inline-flex; align-items: center;">
                              Beginso
                              <span style="display: inline-block; width: 6px; height: 6px; background-color: #2563EB; border-radius: 50%; margin-left: 4px;"></span>
                            </span>
                          </td>
                        </tr>
                      </table>

                      <!-- Heading & Copy -->
                      <h1 style="font-size: 24px; font-weight: 700; color: #111827; margin: 0 0 12px 0; letter-spacing: -0.3px;">Verify your email address</h1>
                      <p style="font-size: 15px; color: #4B5563; line-height: 1.6; margin: 0 0 24px 0;">Click the button below to securely view your six-digit verification code.</p>

                      <!-- Primary CTA Button -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 28px;">
                        <tr>
                          <td align="center">
                            <a href="${revealUrl}" target="_blank" style="background-color: #2563EB; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px; display: inline-block; box-shadow: 0 4px 14px 0 rgba(37, 99, 235, 0.35);">View verification code</a>
                          </td>
                        </tr>
                      </table>

                      <p style="font-size: 13px; color: #6B7280; margin: 0 0 24px 0; text-align: center;">⏱️ This secure link and its verification code expire in <strong>10 minutes</strong>.</p>

                      <!-- Direct Link Fallback -->
                      <div style="background-color: #F9FAFB; border: 1px solid #F3F4F6; border-radius: 10px; padding: 16px; margin-bottom: 24px;">
                        <p style="font-size: 12px; color: #6B7280; margin: 0 0 6px 0; font-weight: 600;">Button not working? Copy and paste this link into your browser:</p>
                        <a href="${revealUrl}" target="_blank" style="font-size: 12px; color: #2563EB; word-break: break-all; text-decoration: underline;">${revealUrl}</a>
                      </div>

                      <!-- Security Shield Card -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #F9FAFB; border-radius: 8px; padding: 14px 16px; margin-bottom: 24px;">
                        <tr>
                          <td style="font-size: 13px; color: #6B7280; line-height: 1.5;">
                            🛡️ <strong>Security Notice:</strong> The verification code is generated only when you click the button above and is displayed once securely on the Beginso website.
                          </td>
                        </tr>
                      </table>

                      <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 28px 0 20px 0;" />
                      
                      <!-- Footer -->
                      <p style="font-size: 12px; color: #9CA3AF; margin: 0; line-height: 1.5; text-align: center;">
                        If you did not create a Beginso account, ignore this email.<br/>
                        &copy; ${new Date().getFullYear()} Beginso Inc. All rights reserved.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `;
    } else if (template === "reset_password") {
      subject = "Reset your Beginso password";
      const resetUrl = actionUrl || `${appUrl}/reset-password`;

      textContent = `Reset your password\n\nWe received a request to reset your Beginso password.\n\nClick the link below to create a new password:\n${resetUrl}\n\nIf you didn't request this change, you can safely ignore this email.`;

      htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${subject}</title>
        </head>
        <body style="margin: 0; padding: 0; background-color: #F3F4F6; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #F3F4F6; padding: 40px 16px;">
            <tr>
              <td align="center">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 540px; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #E5E7EB; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05), 0 8px 10px -6px rgba(0,0,0,0.01);">
                  <!-- Header Gradient Bar -->
                  <tr>
                    <td style="background: linear-gradient(135deg, #1E40AF 0%, #3B82F6 100%); height: 8px;"></td>
                  </tr>
                  
                  <!-- Main Content Area -->
                  <tr>
                    <td style="padding: 40px 36px 36px 36px;">
                      <!-- Logo -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 28px;">
                        <tr>
                          <td>
                            <span style="font-size: 26px; font-weight: 800; color: #1E40AF; letter-spacing: -0.8px; display: inline-flex; align-items: center;">
                              Beginso
                              <span style="display: inline-block; width: 6px; height: 6px; background-color: #2563EB; border-radius: 50%; margin-left: 4px;"></span>
                            </span>
                          </td>
                        </tr>
                      </table>

                      <!-- Heading & Copy -->
                      <h1 style="font-size: 24px; font-weight: 700; color: #111827; margin: 0 0 12px 0; letter-spacing: -0.3px;">Reset your password</h1>
                      <p style="font-size: 15px; color: #4B5563; line-height: 1.6; margin: 0 0 8px 0;">We received a request to reset your Beginso password.</p>
                      <p style="font-size: 15px; color: #4B5563; line-height: 1.6; margin: 0 0 28px 0;">Click the button below to create a new password.</p>

                      <!-- Primary CTA Button -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 28px;">
                        <tr>
                          <td align="center">
                            <a href="${resetUrl}" target="_blank" style="background-color: #2563EB; color: #ffffff; padding: 14px 36px; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px; display: inline-block; box-shadow: 0 4px 14px 0 rgba(37, 99, 235, 0.35);">Reset password</a>
                          </td>
                        </tr>
                      </table>

                      <!-- Direct Link Fallback -->
                      <div style="background-color: #F9FAFB; border: 1px solid #F3F4F6; border-radius: 10px; padding: 16px; margin-bottom: 28px;">
                        <p style="font-size: 12px; color: #6B7280; margin: 0 0 6px 0; font-weight: 600;">Button not working? Copy and paste this link into your browser:</p>
                        <a href="${resetUrl}" target="_blank" style="font-size: 12px; color: #2563EB; word-break: break-all; text-decoration: underline;">${resetUrl}</a>
                      </div>

                      <!-- Security Notice Card -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #FEF2F2; border: 1px solid #FEE2E2; border-radius: 8px; padding: 14px 16px; margin-bottom: 24px;">
                        <tr>
                          <td style="font-size: 13px; color: #991B1B; line-height: 1.5;">
                            🔒 <strong>Notice:</strong> If you didn't request a password reset, your password remains secure and unchanged. You can safely ignore this message.
                          </td>
                        </tr>
                      </table>

                      <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 28px 0 20px 0;" />
                      
                      <!-- Footer -->
                      <p style="font-size: 12px; color: #9CA3AF; margin: 0; line-height: 1.5; text-align: center;">
                        If you didn't request this change, you can safely ignore this email.<br/>
                        &copy; ${new Date().getFullYear()} Beginso Inc. All rights reserved.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `;
    } else if (template === "welcome_user") {
      subject = "Welcome to Beginso! 🎉";
      const dashboardUrl = actionUrl || `${appUrl}/dashboard`;
      const displayName = name || "there";

      textContent = `Welcome to Beginso, ${displayName}!\n\nWe're thrilled to have you on board. Beginso gives you powerful tools to create forms, collect responses, and analyze customer data effortlessly.\n\nGet Started: ${dashboardUrl}\n\nNeed help? Reply directly to this email or visit our help center.\n\n© ${new Date().getFullYear()} Beginso Inc. All rights reserved.`;

      htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${subject}</title>
        </head>
        <body style="margin: 0; padding: 0; background-color: #F3F4F6; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #F3F4F6; padding: 40px 16px;">
            <tr>
              <td align="center">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 540px; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #E5E7EB; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05), 0 8px 10px -6px rgba(0,0,0,0.01);">
                  <!-- Header Gradient Bar -->
                  <tr>
                    <td style="background: linear-gradient(135deg, #2563EB 0%, #7C3AED 100%); height: 8px;"></td>
                  </tr>
                  
                  <!-- Main Content Area -->
                  <tr>
                    <td style="padding: 40px 36px 36px 36px;">
                      <!-- Logo -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 28px;">
                        <tr>
                          <td>
                            <span style="font-size: 26px; font-weight: 800; color: #1E40AF; letter-spacing: -0.8px; display: inline-flex; align-items: center;">
                              Beginso
                              <span style="display: inline-block; width: 6px; height: 6px; background-color: #2563EB; border-radius: 50%; margin-left: 4px;"></span>
                            </span>
                          </td>
                        </tr>
                      </table>

                      <!-- Heading & Welcome Banner -->
                      <h1 style="font-size: 24px; font-weight: 700; color: #111827; margin: 0 0 12px 0; letter-spacing: -0.3px;">Welcome to Beginso, ${displayName}! 👋</h1>
                      <p style="font-size: 15px; color: #4B5563; line-height: 1.6; margin: 0 0 24px 0;">We're thrilled to have you join our platform. Beginso is built to help you design stunning interactive forms, capture responses seamlessly, and turn data into growth.</p>

                      <!-- Feature Grid Box -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 28px;">
                        <tr>
                          <td style="background-color: #F9FAFB; border: 1px solid #F3F4F6; border-radius: 12px; padding: 20px;">
                            <div style="margin-bottom: 14px;">
                              <span style="font-size: 16px; margin-right: 8px;">⚡</span>
                              <strong style="font-size: 14px; color: #111827;">Instant Form Builder:</strong>
                              <span style="font-size: 13px; color: #6B7280; display: block; margin-top: 2px;">Create customized multi-step forms in seconds.</span>
                            </div>
                            <div style="margin-bottom: 14px;">
                              <span style="font-size: 16px; margin-right: 8px;">📊</span>
                              <strong style="font-size: 14px; color: #111827;">Real-time Analytics:</strong>
                              <span style="font-size: 13px; color: #6B7280; display: block; margin-top: 2px;">Track submission trends and conversion performance live.</span>
                            </div>
                            <div>
                              <span style="font-size: 16px; margin-right: 8px;">🔒</span>
                              <strong style="font-size: 14px; color: #111827;">Enterprise Security:</strong>
                              <span style="font-size: 13px; color: #6B7280; display: block; margin-top: 2px;">Your data is encrypted and protected by strict session controls.</span>
                            </div>
                          </td>
                        </tr>
                      </table>

                      <!-- Primary CTA Button -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 28px;">
                        <tr>
                          <td align="center">
                            <a href="${dashboardUrl}" target="_blank" style="background-color: #2563EB; color: #ffffff; padding: 14px 36px; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px; display: inline-block; box-shadow: 0 4px 14px 0 rgba(37, 99, 235, 0.35);">Go to Dashboard</a>
                          </td>
                        </tr>
                      </table>

                      <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 28px 0 20px 0;" />
                      
                      <!-- Footer -->
                      <p style="font-size: 12px; color: #9CA3AF; margin: 0; line-height: 1.5; text-align: center;">
                        Need help getting started? Simply reply directly to this email.<br/>
                        &copy; ${new Date().getFullYear()} Beginso Inc. All rights reserved.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `;
    } else if (template === "workspace_invitation") {
      const wsName = workspaceName || "our workspace";
      const inviter = inviterName || "A team member";
      const rawRole = role || "member";
      const roleDisplay = rawRole.charAt(0).toUpperCase() + rawRole.slice(1).toLowerCase();
      const acceptUrl = actionUrl || `${appUrl}/dashboard`;

      subject = `You've been invited to join ${wsName} on Beginso ✉️`;

      textContent = `You've been invited to join ${wsName} on Beginso!\n\n${inviter} has invited you to collaborate in the ${wsName} workspace as a ${roleDisplay}.\n\nWorkspace: ${wsName}\nYour Role: ${roleDisplay}\nInvited Email: ${to}\n\nAccept your invitation: ${acceptUrl}\n\nThis invitation link expires in 7 days. If you weren't expecting this invitation, you can safely ignore this email.\n\n© ${new Date().getFullYear()} Beginso Inc. All rights reserved.`;

      htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${subject}</title>
        </head>
        <body style="margin: 0; padding: 0; background-color: #F3F4F6; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #F3F4F6; padding: 40px 16px;">
            <tr>
              <td align="center">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 540px; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #E5E7EB; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05), 0 8px 10px -6px rgba(0,0,0,0.01);">
                  <!-- Header Gradient Bar -->
                  <tr>
                    <td style="background: linear-gradient(135deg, #2563EB 0%, #7C3AED 100%); height: 8px;"></td>
                  </tr>
                  
                  <!-- Main Content Area -->
                  <tr>
                    <td style="padding: 40px 36px 36px 36px;">
                      <!-- Logo -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 28px;">
                        <tr>
                          <td>
                            <span style="font-size: 26px; font-weight: 800; color: #1E40AF; letter-spacing: -0.8px; display: inline-flex; align-items: center;">
                              Beginso
                              <span style="display: inline-block; width: 6px; height: 6px; background-color: #2563EB; border-radius: 50%; margin-left: 4px;"></span>
                            </span>
                          </td>
                        </tr>
                      </table>

                      <!-- Heading -->
                      <h1 style="font-size: 24px; font-weight: 700; color: #111827; margin: 0 0 12px 0; letter-spacing: -0.3px;">You've been invited to ${wsName}! ✉️</h1>
                      <p style="font-size: 15px; color: #4B5563; line-height: 1.6; margin: 0 0 24px 0;"><strong>${inviter}</strong> has invited you to collaborate in the <strong>${wsName}</strong> workspace on Beginso as a <strong>${roleDisplay}</strong>.</p>

                      <!-- Invitation Details Box (Same layout as welcome mail) -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 28px;">
                        <tr>
                          <td style="background-color: #F9FAFB; border: 1px solid #F3F4F6; border-radius: 12px; padding: 20px;">
                            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                              <tr>
                                <td style="padding-bottom: 12px;">
                                  <span style="font-size: 13px; color: #6B7280;">🏢 Workspace</span>
                                  <strong style="font-size: 15px; color: #111827; display: block; margin-top: 2px;">${wsName}</strong>
                                </td>
                              </tr>
                              <tr>
                                <td style="padding-bottom: 12px;">
                                  <span style="font-size: 13px; color: #6B7280;">👤 Assigned Role</span>
                                  <div style="margin-top: 4px;">
                                    <span style="font-size: 12px; font-weight: 700; color: #1D4ED8; background-color: #DBEAFE; padding: 3px 10px; border-radius: 20px; display: inline-block; text-transform: uppercase; letter-spacing: 0.5px;">${roleDisplay}</span>
                                  </div>
                                </td>
                              </tr>
                              <tr>
                                <td>
                                  <span style="font-size: 13px; color: #6B7280;">✉️ Invited Email</span>
                                  <strong style="font-size: 14px; color: #111827; display: block; margin-top: 2px;">${to}</strong>
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>

                      <!-- Primary CTA Button -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 24px;">
                        <tr>
                          <td align="center">
                            <a href="${acceptUrl}" target="_blank" style="background-color: #2563EB; color: #ffffff; padding: 14px 36px; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px; display: inline-block; box-shadow: 0 4px 14px 0 rgba(37, 99, 235, 0.35);">Accept Invitation</a>
                          </td>
                        </tr>
                      </table>

                      <!-- Backup Link -->
                      <p style="font-size: 13px; color: #6B7280; line-height: 1.5; margin: 0 0 24px 0; text-align: center;">
                        Button not working? Copy and paste this URL into your browser:<br/>
                        <a href="${acceptUrl}" style="color: #2563EB; word-break: break-all; text-decoration: underline;">${acceptUrl}</a>
                      </p>

                      <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 28px 0 20px 0;" />
                      
                      <!-- Footer -->
                      <p style="font-size: 12px; color: #9CA3AF; margin: 0; line-height: 1.5; text-align: center;">
                        This invitation link expires in 7 days. If you weren't expecting this invitation, you can safely ignore this email.<br/>
                        &copy; ${new Date().getFullYear()} Beginso Inc. All rights reserved.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `;
    } else if (template === "email_verified_success") {
      subject = "Your email has been verified! ✅";
      const dashboardUrl = actionUrl || `${appUrl}/dashboard`;

      textContent = `Email Verified Successfully!\n\nYour Beginso account email (${to}) has been verified.\n\nYou can now log in and access your workspace.\n\nGo to Dashboard: ${dashboardUrl}\n\n© ${new Date().getFullYear()} Beginso Inc. All rights reserved.`;

      htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${subject}</title>
        </head>
        <body style="margin: 0; padding: 0; background-color: #F3F4F6; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #F3F4F6; padding: 40px 16px;">
            <tr>
              <td align="center">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 540px; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #E5E7EB; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05), 0 8px 10px -6px rgba(0,0,0,0.01);">
                  <!-- Header Gradient Bar -->
                  <tr>
                    <td style="background: linear-gradient(135deg, #059669 0%, #10B981 100%); height: 8px;"></td>
                  </tr>
                  
                  <!-- Main Content Area -->
                  <tr>
                    <td style="padding: 40px 36px 36px 36px;">
                      <!-- Logo -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 28px;">
                        <tr>
                          <td>
                            <span style="font-size: 26px; font-weight: 800; color: #1E40AF; letter-spacing: -0.8px; display: inline-flex; align-items: center;">
                              Beginso
                              <span style="display: inline-block; width: 6px; height: 6px; background-color: #10B981; border-radius: 50%; margin-left: 4px;"></span>
                            </span>
                          </td>
                        </tr>
                      </table>

                      <!-- Verified Badge Graphic -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 24px;">
                        <tr>
                          <td align="center">
                            <div style="display: inline-block; width: 64px; height: 64px; background-color: #D1FAE5; border-radius: 50%; text-align: center; line-height: 64px;">
                              <span style="font-size: 32px;">✅</span>
                            </div>
                          </td>
                        </tr>
                      </table>

                      <!-- Heading & Copy -->
                      <h1 style="font-size: 24px; font-weight: 700; color: #111827; margin: 0 0 12px 0; letter-spacing: -0.3px; text-align: center;">Email Verified Successfully!</h1>
                      <p style="font-size: 15px; color: #4B5563; line-height: 1.6; margin: 0 0 24px 0; text-align: center;">Your email address <strong>${to}</strong> has been confirmed. Your account is fully active and ready to use.</p>

                      <!-- Primary CTA Button -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 28px;">
                        <tr>
                          <td align="center">
                            <a href="${dashboardUrl}" target="_blank" style="background-color: #059669; color: #ffffff; padding: 14px 36px; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px; display: inline-block; box-shadow: 0 4px 14px 0 rgba(5, 150, 105, 0.35);">Open Beginso Workspace</a>
                          </td>
                        </tr>
                      </table>

                      <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 28px 0 20px 0;" />
                      
                      <!-- Footer -->
                      <p style="font-size: 12px; color: #9CA3AF; margin: 0; line-height: 1.5; text-align: center;">
                        Thank you for verifying your email.<br/>
                        &copy; ${new Date().getFullYear()} Beginso Inc. All rights reserved.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `;
    } else if (template === "password_changed_success") {
      subject = "Security Alert: Your Beginso password was updated";
      const loginUrl = actionUrl || `${appUrl}/login`;

      textContent = `Password Changed Successfully\n\nYour Beginso account password was updated on ${new Date().toUTCString()}.\n\nIf you performed this action, no further steps are required.\n\nIf you did NOT update your password, please reset your password immediately: ${loginUrl}\n\n© ${new Date().getFullYear()} Beginso Inc. All rights reserved.`;

      htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${subject}</title>
        </head>
        <body style="margin: 0; padding: 0; background-color: #F3F4F6; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #F3F4F6; padding: 40px 16px;">
            <tr>
              <td align="center">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 540px; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #E5E7EB; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05), 0 8px 10px -6px rgba(0,0,0,0.01);">
                  <!-- Header Gradient Bar -->
                  <tr>
                    <td style="background: linear-gradient(135deg, #DC2626 0%, #F59E0B 100%); height: 8px;"></td>
                  </tr>
                  
                  <!-- Main Content Area -->
                  <tr>
                    <td style="padding: 40px 36px 36px 36px;">
                      <!-- Logo -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 28px;">
                        <tr>
                          <td>
                            <span style="font-size: 26px; font-weight: 800; color: #1E40AF; letter-spacing: -0.8px; display: inline-flex; align-items: center;">
                              Beginso
                              <span style="display: inline-block; width: 6px; height: 6px; background-color: #DC2626; border-radius: 50%; margin-left: 4px;"></span>
                            </span>
                          </td>
                        </tr>
                      </table>

                      <!-- Heading & Security Shield Graphic -->
                      <h1 style="font-size: 24px; font-weight: 700; color: #111827; margin: 0 0 12px 0; letter-spacing: -0.3px;">Password Updated Successfully 🔐</h1>
                      <p style="font-size: 15px; color: #4B5563; line-height: 1.6; margin: 0 0 20px 0;">Your Beginso account password was updated on <strong>${new Date().toUTCString()}</strong>.</p>

                      <!-- Security Warning Alert Box -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #FEF2F2; border: 1px solid #FEE2E2; border-radius: 10px; padding: 16px; margin-bottom: 28px;">
                        <tr>
                          <td style="font-size: 13px; color: #991B1B; line-height: 1.6;">
                            🚨 <strong>Security Alert:</strong> If you performed this change, you can safely ignore this message. If you did <strong>NOT</strong> authorize this change, someone may have accessed your account. Reset your password immediately or contact security support.
                          </td>
                        </tr>
                      </table>

                      <!-- Primary CTA Button -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 28px;">
                        <tr>
                          <td align="center">
                            <a href="${loginUrl}" target="_blank" style="background-color: #111827; color: #ffffff; padding: 14px 36px; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px; display: inline-block; box-shadow: 0 4px 14px 0 rgba(17, 24, 39, 0.25);">Sign In to Your Account</a>
                          </td>
                        </tr>
                      </table>

                      <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 28px 0 20px 0;" />
                      
                      <!-- Footer -->
                      <p style="font-size: 12px; color: #9CA3AF; margin: 0; line-height: 1.5; text-align: center;">
                        This security notification was sent to <strong>${to}</strong>.<br/>
                        &copy; ${new Date().getFullYear()} Beginso Inc. All rights reserved.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `;
    }

    try {
      const transporter = this.getTransporter();
      await transporter.sendMail({
        from,
        to,
        subject,
        text: textContent,
        html: htmlContent,
      });
      console.log(`✉️ Email sent successfully to ${to} [template: ${template}]`);

      if (mappedLogTemplate) {
        await recordMailLog({
          template: mappedLogTemplate,
          outcome: "sent",
          email: to,
          firebaseUid,
          requestId: reqId,
          provider: "smtp",
          latencyMs: Date.now() - startTime,
        });
      }
    } catch (err: any) {
      console.error(`❌ Failed to send ${template} email to ${to}:`, err.message);

      if (mappedLogTemplate) {
        await recordMailLog({
          template: mappedLogTemplate,
          outcome: "failed",
          email: to,
          firebaseUid,
          requestId: reqId,
          provider: "smtp",
          errorCode: err.code || err.name || "PROVIDER_ERROR",
          latencyMs: Date.now() - startTime,
        });
      }
    }
  }
}

export const mailService = new MailService();
