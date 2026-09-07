import mongoose from "mongoose";
import dotenv from "dotenv";
import ReportModel from "../models/Report";
import Form from "../models/Form";
import { generateReportAsync } from "../services/report.service";

dotenv.config();

const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/onboarding";

const runTest = async () => {
  try {
    await mongoose.connect(mongoUri);
    console.log("Connected to DB");

    const form = await Form.findOne({ title: new RegExp("Job Application", "i") });
    if (!form) {
      console.log("Form not found");
      process.exit(1);
    }

    console.log("Found Form:", form.title, form._id);

    const report: any = await ReportModel.create({
      workspaceId: form.workspaceId || new mongoose.Types.ObjectId(),
      format: "pdf",
      filters: {
        formId: form._id.toString(),
        from: "2026-07-15T00:00:00.000Z",
        to: "2026-08-14T23:59:59.999Z",
      },
      status: "queued",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    console.log("Created test PDF report job:", report._id);

    await generateReportAsync(report._id.toString());

    const updatedReport = await ReportModel.findById(report._id);
    console.log("Updated Report Status:", updatedReport?.status);
    console.log("Updated Report Error:", updatedReport?.errorMessage);
    console.log("Updated Report FilePath:", updatedReport?.filePath);
    console.log("Updated Report FileSize:", updatedReport?.fileSize);

    await mongoose.disconnect();
  } catch (err) {
    console.error("Test failed with error:", err);
  }
};

runTest();
