import dotenv from "dotenv";
import { mailService } from "../services/mail.service";

dotenv.config();

const targetEmail = "jayesh@dhkinnovations.com";

const sendAllTestEmails = async () => {
  console.log(`🚀 Dispatching all 5 email templates to ${targetEmail}...`);

  try {
    // 1. Email Verification Template
    console.log("✉️ Sending 1/5: verify_email template...");
    await mailService.sendMail({
      to: targetEmail,
      template: "verify_email",
      actionUrl: "https://beginso.com/verification-code?ticket=sample_ticket_abc123",
      name: "Jayesh",
    });

    // 2. Password Reset Template
    console.log("✉️ Sending 2/5: reset_password template...");
    await mailService.sendMail({
      to: targetEmail,
      template: "reset_password",
      actionUrl: "https://beginso.com/reset-password?oobCode=sample_reset_oob_xyz789",
      name: "Jayesh",
    });

    // 3. Welcome User Template
    console.log("✉️ Sending 3/5: welcome_user template...");
    await mailService.sendMail({
      to: targetEmail,
      template: "welcome_user",
      actionUrl: "https://beginso.com/dashboard",
      name: "Jayesh",
    });

    // 4. Email Verified Success Template
    console.log("✉️ Sending 4/5: email_verified_success template...");
    await mailService.sendMail({
      to: targetEmail,
      template: "email_verified_success",
      actionUrl: "https://beginso.com/dashboard",
      name: "Jayesh",
    });

    // 5. Password Changed Security Alert Template
    console.log("✉️ Sending 5/6: password_changed_success template...");
    await mailService.sendMail({
      to: targetEmail,
      template: "password_changed_success",
      actionUrl: "https://beginso.com/login",
      name: "Jayesh",
    });

    // 6. Workspace Invitation Template
    console.log("✉️ Sending 6/6: workspace_invitation template...");
    await mailService.sendMail({
      to: targetEmail,
      template: "workspace_invitation",
      actionUrl: "https://beginso.com/invite/sample_invite_token_123",
      name: "Jayesh",
      workspaceName: "Acme Product Team",
      inviterName: "Alex Smith",
      role: "admin",
    });

    console.log(`\n🎉 ALL 6 EMAIL TEMPLATES SENT SUCCESSFULLY TO ${targetEmail}!`);
  } catch (error) {
    console.error("❌ Error sending test emails:", error);
  }
};

sendAllTestEmails();
