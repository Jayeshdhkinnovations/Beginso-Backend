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

const BEGINSO_LOGO_SVG = `<svg width="160" height="44" viewBox="0 0 1597 440" fill="none" xmlns="http://www.w3.org/2000/svg" style="display: block; width: 160px; max-width: 100%; height: auto; border: 0;">
  <path d="M438.661 323V113H520.861C535.661 113 547.961 115.3 557.761 119.9C567.761 124.5 575.261 130.9 580.261 139.1C585.261 147.1 587.761 156.4 587.761 167C587.761 177.6 585.461 186.5 580.861 193.7C576.261 200.9 570.161 206.4 562.561 210.2C555.161 214 547.061 216.3 538.261 217.1L542.761 213.8C552.161 214 560.561 216.5 567.961 221.3C575.561 226.1 581.561 232.4 585.961 240.2C590.361 247.8 592.561 256.3 592.561 265.7C592.561 276.7 589.861 286.6 584.461 295.4C579.261 304 571.561 310.8 561.361 315.8C551.161 320.6 538.661 323 523.861 323H438.661ZM474.661 293.6H518.461C530.261 293.6 539.461 290.8 546.061 285.2C552.661 279.6 555.961 271.8 555.961 261.8C555.961 251.8 552.561 243.9 545.761 238.1C538.961 232.1 529.661 229.1 517.861 229.1H474.661V293.6ZM474.661 201.8H515.761C527.361 201.8 536.161 199.2 542.161 194C548.161 188.6 551.161 181.2 551.161 171.8C551.161 162.6 548.161 155.4 542.161 150.2C536.161 144.8 527.261 142.1 515.461 142.1H474.661V201.8ZM696.64 326.6C681.64 326.6 668.44 323.4 657.04 317C645.64 310.4 636.74 301.2 630.34 289.4C623.94 277.6 620.74 264 620.74 248.6C620.74 232.6 623.84 218.6 630.04 206.6C636.44 194.6 645.34 185.2 656.74 178.4C668.34 171.6 681.74 168.2 696.94 168.2C711.74 168.2 724.64 171.5 735.64 178.1C746.64 184.7 755.14 193.6 761.14 204.8C767.14 215.8 770.14 228.2 770.14 242C770.14 244 770.14 246.2 770.14 248.6C770.14 251 769.94 253.5 769.54 256.1H646.54V233H733.84C733.44 222 729.74 213.4 722.74 207.2C715.74 200.8 707.04 197.6 696.64 197.6C689.24 197.6 682.44 199.3 676.24 202.7C670.04 206.1 665.14 211.2 661.54 218C657.94 224.6 656.14 233 656.14 243.2V251.9C656.14 261.3 657.84 269.4 661.24 276.2C664.84 283 669.64 288.2 675.64 291.8C681.84 295.2 688.74 296.9 696.34 296.9C704.74 296.9 711.64 295.1 717.04 291.5C722.64 287.9 726.74 283.1 729.34 277.1H765.94C763.14 286.5 758.54 295 752.14 302.6C745.74 310 737.84 315.9 728.44 320.3C719.04 324.5 708.44 326.6 696.64 326.6ZM864.05 392.6C849.85 392.6 837.35 390.8 826.55 387.2C815.95 383.8 807.65 378.5 801.65 371.3C795.85 364.3 792.95 355.5 792.95 344.9C792.95 338.7 794.45 332.6 797.45 326.6C800.65 320.8 805.35 315.4 811.55 310.4C817.95 305.2 826.05 300.7 835.85 296.9L851.75 314.3C842.15 317.7 835.45 321.8 831.65 326.6C827.85 331.4 825.95 336.3 825.95 341.3C825.95 346.5 827.55 350.8 830.75 354.2C834.15 357.8 838.65 360.5 844.25 362.3C850.05 364.1 856.55 365 863.75 365C870.75 365 876.85 364 882.05 362C887.25 360.2 891.25 357.6 894.05 354.2C897.05 350.8 898.55 346.7 898.55 341.9C898.55 335.9 896.45 331 892.25 327.2C888.05 323.6 879.75 321.4 867.35 320.6C856.75 319.8 847.45 318.7 839.45 317.3C831.45 315.7 824.55 313.9 818.75 311.9C813.15 309.9 808.35 307.7 804.35 305.3C800.35 302.7 797.05 300.1 794.45 297.5V290.6L825.95 257.6L852.65 266.3L817.25 300.8L826.55 283.4C828.55 284.8 830.55 286.1 832.55 287.3C834.75 288.5 837.45 289.6 840.65 290.6C844.05 291.4 848.45 292.2 853.85 293C859.25 293.8 866.25 294.6 874.85 295.4C888.25 296.4 899.15 298.8 907.55 302.6C915.95 306.4 922.15 311.5 926.15 317.9C930.15 324.3 932.15 332 932.15 341C932.15 349.8 929.65 358.1 924.65 365.9C919.85 373.7 912.45 380.1 902.45 385.1C892.45 390.1 879.65 392.6 864.05 392.6ZM864.05 277.7C851.45 277.7 840.55 275.3 831.35 270.5C822.35 265.5 815.45 258.9 810.65 250.7C805.85 242.3 803.45 233.1 803.45 223.1C803.45 212.9 805.85 203.7 810.65 195.5C815.45 187.3 822.35 180.7 831.35 175.7C840.55 170.7 851.45 168.2 864.05 168.2C876.65 168.2 887.45 170.7 896.45 175.7C905.45 180.7 912.35 187.3 917.15 195.5C921.95 203.7 924.35 212.9 924.35 223.1C924.35 233.1 921.95 242.3 917.15 250.7C912.35 258.9 905.45 265.5 896.45 270.5C887.45 275.3 876.65 277.7 864.05 277.7ZM864.05 249.8C872.65 249.8 879.55 247.5 884.75 242.9C889.95 238.3 892.55 231.7 892.55 223.1C892.55 214.5 889.95 208 884.75 203.6C879.55 199 872.65 196.7 864.05 196.7C855.45 196.7 848.45 199 843.05 203.6C837.65 208 834.95 214.5 834.95 223.1C834.95 231.7 837.65 238.3 843.05 242.9C848.45 247.5 855.45 249.8 864.05 249.8ZM888.95 198.2L882.05 171.8H944.15V194.3L888.95 198.2ZM977.438 323V171.8H1013.44V323H977.438ZM995.438 147.8C988.838 147.8 983.338 145.8 978.938 141.8C974.738 137.6 972.638 132.5 972.638 126.5C972.638 120.3 974.738 115.3 978.938 111.5C983.338 107.5 988.838 105.5 995.438 105.5C1002.04 105.5 1007.44 107.5 1011.64 111.5C1016.04 115.3 1018.24 120.3 1018.24 126.5C1018.24 132.5 1016.04 137.6 1011.64 141.8C1007.44 145.8 1002.04 147.8 995.438 147.8ZM1055.04 323V171.8H1086.84L1089.54 197C1094.14 188.2 1100.74 181.2 1109.34 176C1117.94 170.8 1128.14 168.2 1139.94 168.2C1152.14 168.2 1162.54 170.8 1171.14 176C1179.74 181 1186.34 188.4 1190.94 198.2C1195.74 208 1198.14 220.2 1198.14 234.8V323H1162.14V238.1C1162.14 225.5 1159.34 215.8 1153.74 209C1148.14 202.2 1139.84 198.8 1128.84 198.8C1121.64 198.8 1115.14 200.5 1109.34 203.9C1103.74 207.3 1099.24 212.3 1095.84 218.9C1092.64 225.3 1091.04 233.1 1091.04 242.3V323H1055.04Z" fill="#041347"/>
  <path d="M1307.79 326.6C1292.59 326.6 1279.09 323.9 1267.29 318.5C1255.49 313.1 1246.29 305.4 1239.69 295.4C1233.09 285.4 1229.69 273.5 1229.49 259.7H1267.59C1267.59 266.7 1269.19 273 1272.39 278.6C1275.79 284 1280.39 288.3 1286.19 291.5C1292.19 294.7 1299.39 296.3 1307.79 296.3C1314.99 296.3 1321.19 295.2 1326.39 293C1331.79 290.6 1335.89 287.3 1338.69 283.1C1341.69 278.7 1343.19 273.6 1343.19 267.8C1343.19 261.2 1341.59 255.8 1338.39 251.6C1335.39 247.2 1331.19 243.5 1325.79 240.5C1320.39 237.5 1314.19 234.9 1307.19 232.7C1300.19 230.3 1292.79 227.8 1284.99 225.2C1268.39 219.6 1255.89 212.5 1247.49 203.9C1239.09 195.1 1234.89 183.4 1234.89 168.8C1234.89 156.6 1237.79 146.1 1243.59 137.3C1249.39 128.5 1257.49 121.7 1267.89 116.9C1278.49 111.9 1290.69 109.4 1304.49 109.4C1318.49 109.4 1330.69 111.9 1341.09 116.9C1351.69 121.9 1359.99 128.9 1365.99 137.9C1372.19 146.7 1375.39 157.3 1375.59 169.7H1337.19C1336.99 164.5 1335.59 159.7 1332.99 155.3C1330.39 150.7 1326.59 147 1321.59 144.2C1316.79 141.2 1310.89 139.7 1303.89 139.7C1297.89 139.5 1292.49 140.5 1287.69 142.7C1283.09 144.7 1279.39 147.7 1276.59 151.7C1273.99 155.5 1272.69 160.3 1272.69 166.1C1272.69 171.7 1273.89 176.4 1276.29 180.2C1278.89 183.8 1282.59 186.9 1287.39 189.5C1292.19 191.9 1297.79 194.2 1304.19 196.4C1310.59 198.6 1317.59 201 1325.19 203.6C1335.59 207 1344.99 211.2 1353.39 216.2C1361.99 221 1368.79 227.3 1373.79 235.1C1378.79 242.9 1381.29 253 1381.29 265.4C1381.29 276.2 1378.49 286.3 1372.89 295.7C1367.29 304.9 1359.09 312.4 1348.29 318.2C1337.49 323.8 1323.99 326.6 1307.79 326.6ZM1485.6 326.6C1471.2 326.6 1458.2 323.3 1446.6 316.7C1435.2 309.9 1426.2 300.6 1419.6 288.8C1413.2 276.8 1410 263.1 1410 247.7C1410 231.9 1413.3 218.1 1419.9 206.3C1426.5 194.3 1435.5 185 1446.9 178.4C1458.5 171.6 1471.5 168.2 1485.9 168.2C1500.3 168.2 1513.2 171.6 1524.6 178.4C1536.2 185 1545.2 194.2 1551.6 206C1558.2 217.8 1561.5 231.6 1561.5 247.4C1561.5 263.2 1558.2 277 1551.6 288.8C1545 300.6 1535.9 309.9 1524.3 316.7C1512.9 323.3 1500 326.6 1485.6 326.6ZM1485.6 295.7C1492.8 295.7 1499.3 293.9 1505.1 290.3C1511.1 286.7 1515.9 281.3 1519.5 274.1C1523.1 266.9 1524.9 258 1524.9 247.4C1524.9 236.8 1523.1 228 1519.5 221C1516.1 213.8 1511.4 208.4 1505.4 204.8C1499.6 201.2 1493.1 199.4 1485.9 199.4C1478.9 199.4 1472.4 201.2 1466.4 204.8C1460.4 208.4 1455.6 213.8 1452 221C1448.4 228 1446.6 236.8 1446.6 247.4C1446.6 258 1448.4 266.9 1452 274.1C1455.6 281.3 1460.3 286.7 1466.1 290.3C1472.1 293.9 1478.6 295.7 1485.6 295.7Z" fill="#4274D9"/>
  <path d="M249.596 92.6621C270.167 92.6621 288.256 111.198 288.256 131.761C288.256 131.761 288.256 317.603 288.256 333.619C288.256 349.635 281.538 365.444 265.515 365.444H233.678V200.411C233.678 170.756 210.586 147.218 180.919 147.218H88.1367V119.94C88.1367 103.924 103.951 92.6621 119.974 92.6621C135.996 92.6621 249.596 92.6621 249.596 92.6621Z" fill="#7AB2D3"/>
  <path d="M320.025 20C345.131 20 356.392 40.3492 356.392 65.4512V274.526C356.392 299.628 345.131 310.887 320.025 310.887H301.841V131.81C301.841 102.163 279.215 79.0865 249.562 79.0865H133.641V51.8158C133.641 35.8041 149.448 20 165.462 20L320.025 20Z" fill="#4274D9"/>
  <path d="M20 199.906C20 178.307 37.512 160.798 59.1142 160.798H181.005C202.607 160.798 220.119 178.307 220.119 199.906V380.892C220.119 402.491 202.607 420 181.005 420H59.1142C37.512 420 20 402.491 20 380.892V199.906Z" fill="#041347"/>
</svg>`;

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
                    <td style="background: #041347; background: linear-gradient(90deg, #041347 0%, #4274D9 100%); height: 8px;"></td>
                  </tr>
                  
                  <!-- Main Content Area -->
                  <tr>
                    <td style="padding: 40px 36px 36px 36px;">
                      <!-- Logo -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 28px;">
                        <tr>
                          <td>
                            ${BEGINSO_LOGO_SVG}
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
                    <td style="background: #041347; background: linear-gradient(90deg, #041347 0%, #4274D9 100%); height: 8px;"></td>
                  </tr>
                  
                  <!-- Main Content Area -->
                  <tr>
                    <td style="padding: 40px 36px 36px 36px;">
                      <!-- Logo -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 28px;">
                        <tr>
                          <td>
                            ${BEGINSO_LOGO_SVG}
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
                    <td style="background: #041347; background: linear-gradient(90deg, #041347 0%, #4274D9 100%); height: 8px;"></td>
                  </tr>
                  
                  <!-- Main Content Area -->
                  <tr>
                    <td style="padding: 40px 36px 36px 36px;">
                      <!-- Logo -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 28px;">
                        <tr>
                          <td>
                            ${BEGINSO_LOGO_SVG}
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
                    <td style="background: #041347; background: linear-gradient(90deg, #041347 0%, #4274D9 100%); height: 8px;"></td>
                  </tr>
                  
                  <!-- Main Content Area -->
                  <tr>
                    <td style="padding: 40px 36px 36px 36px;">
                      <!-- Logo -->
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 28px;">
                        <tr>
                          <td>
                            ${BEGINSO_LOGO_SVG}
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
                            ${BEGINSO_LOGO_SVG}
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
                            ${BEGINSO_LOGO_SVG}
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
