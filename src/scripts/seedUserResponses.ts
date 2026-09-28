import mongoose from "mongoose";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";
import Upload from "../models/Upload";

dotenv.config();

const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/onboarding";
const uploadDir = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");

const sampleFilesData = [
  { name: "applicant_resume.pdf", content: "%PDF-1.4 Sample Resume Content", type: "application/pdf" },
  { name: "identity_passport.png", content: "fake-png-image-binary-data", type: "image/png" },
  { name: "recommendation_letter.pdf", content: "%PDF-1.4 Recommendation Letter Content", type: "application/pdf" },
  { name: "tax_document.pdf", content: "%PDF-1.4 Tax Certificate Content", type: "application/pdf" },
  { name: "portfolio_sample.png", content: "fake-png-portfolio-data", type: "image/png" },
];

const sampleNames = [
  "Alex Rivera", "Sophia Chen", "Marcus Vance", "Elena Rostova", "David Miller",
  "Aaliyah Khan", "Liam O'Connor", "Zoe Takahashi", "Carlos Gomez", "Priya Sharma"
];

const sampleBios = [
  "Senior full-stack engineer with 7+ years of experience building scalable cloud microservices.",
  "Product designer specializing in high-converting SaaS interfaces and design systems.",
  "Data scientist with a background in machine learning models and automated analytics pipelines.",
  "DevOps specialist focused on Kubernetes clusters, CI/CD automation, and infrastructure as code.",
  "Executive project manager leading cross-functional teams in agile enterprise product delivery."
];

const seedUserResponses = async () => {
  try {
    console.log("🚀 Starting Seed for test@gmail.com ...");
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB");

    // 1. Find or create test@gmail.com user
    let user = await User.findOne({ email: /^test@gmail\.com$/i });
    if (!user) {
      user = await User.create({
        fullName: "Test Admin User",
        email: "test@gmail.com",
        firebaseUid: "uid-test-gmail-com",
        role: "admin",
      });
      console.log(`👤 Created user: ${user.email}`);
    } else {
      console.log(`👤 Found user: ${user.email} (${user._id})`);
    }

    // 2. Find or create workspace for user
    let workspace = await Workspace.findOne({ owner: user._id });
    if (!workspace) {
      workspace = await Workspace.create({
        name: "Test Workspace",
        owner: user._id,
      });
      user.workspaceId = workspace._id as any;
      await user.save();
      console.log(`📁 Created workspace: ${workspace.name}`);
    } else {
      console.log(`📁 Found workspace: ${workspace.name} (${workspace._id})`);
    }

    // 3. Find target form "master compresenive template"
    const targetTitleRegex = /master.*compr/i;
    let form = await Form.findOne({
      workspaceId: workspace._id,
      title: { $regex: targetTitleRegex },
    });

    if (!form) {
      // Fallback: check any form owned by user or search globally for test@gmail.com
      form = await Form.findOne({ title: { $regex: targetTitleRegex } });
    }

    if (!form) {
      console.log("ℹ️ Form 'master compresenive template' not found. Creating form now...");
      const page1Id = new mongoose.Types.ObjectId().toString();
      const page2Id = new mongoose.Types.ObjectId().toString();

      form = await Form.create({
        title: "master compresenive template",
        description: "Master comprehensive form template with all field types and file upload support.",
        workspaceId: workspace._id,
        status: "published",
        slug: "master-comprehensive-template",
        publishedSlug: "master-comprehensive-template",
        publishedAt: new Date(),
        pages: [
          { id: page1Id, order: 0, title: "General Information", description: "Personal & contact info" },
          { id: page2Id, order: 1, title: "Documents & Files", description: "Upload required files" },
        ],
        fields: [
          { fieldId: new mongoose.Types.ObjectId().toString(), pageId: page1Id, label: "Full Name", type: "short_text", required: true, placeholder: "John Doe" },
          { fieldId: new mongoose.Types.ObjectId().toString(), pageId: page1Id, label: "Email Address", type: "email", required: true, placeholder: "john@example.com" },
          { fieldId: new mongoose.Types.ObjectId().toString(), pageId: page1Id, label: "Phone Number", type: "phone", required: false, placeholder: "+12025550193" },
          { fieldId: new mongoose.Types.ObjectId().toString(), pageId: page1Id, label: "Years of Experience", type: "number", required: true, min: 1, max: 50 },
          { fieldId: new mongoose.Types.ObjectId().toString(), pageId: page1Id, label: "Submission Date", type: "date", required: true },
          { fieldId: new mongoose.Types.ObjectId().toString(), pageId: page1Id, label: "Preferred Role", type: "dropdown", required: true, options: ["Frontend Engineer", "Backend Engineer", "Product Manager", "UI/UX Designer"] },
          { fieldId: new mongoose.Types.ObjectId().toString(), pageId: page1Id, label: "Work Type", type: "multiple_choice", required: true, options: ["Full-Time", "Part-Time", "Contract"] },
          { fieldId: new mongoose.Types.ObjectId().toString(), pageId: page1Id, label: "Skills", type: "checkbox", required: false, options: ["TypeScript", "Node.js", "React", "MongoDB", "Docker"] },
          { fieldId: new mongoose.Types.ObjectId().toString(), pageId: page1Id, label: "Short Biography", type: "long_text", required: false, placeholder: "Brief bio..." },
          { fieldId: new mongoose.Types.ObjectId().toString(), pageId: page2Id, label: "Resume Document", type: "file_upload", required: true, maxFileSize: 10 },
          { fieldId: new mongoose.Types.ObjectId().toString(), pageId: page2Id, label: "Identity Proof", type: "file_upload", required: false, maxFileSize: 5 },
        ],
      });
      console.log(`📝 Created form: "${form.title}" (${form._id})`);
    } else {
      console.log(`📝 Found form: "${form.title}" (${form._id})`);
    }

    // Ensure form has at least one file_upload field if missing
    const hasFileUpload = form.fields.some((f) => f.type === "file_upload" && !f.deleted);
    if (!hasFileUpload) {
      console.log("➕ Adding file_upload field to form...");
      form.fields.push({
        fieldId: new mongoose.Types.ObjectId().toString(),
        pageId: form.pages?.[0]?.id || new mongoose.Types.ObjectId().toString(),
        label: "Attachment Document",
        type: "file_upload",
        required: true,
        maxFileSize: 10,
        deleted: false,
      } as any);
      await form.save();
    }

    const statuses: Array<"new" | "in_progress" | "completed"> = ["new", "in_progress", "completed", "new", "completed"];

    console.log("\n📦 Generating 5 random responses with file uploads...");

    for (let i = 0; i < 5; i++) {
      const respIdObj = new mongoose.Types.ObjectId();
      const responseIdStr = respIdObj.toString();
      const name = sampleNames[i % sampleNames.length];
      const email = `${name.toLowerCase().replace(/[^a-z]/g, ".")}@example.com`;
      const status = statuses[i];

      const submittedAt = new Date(Date.now() - (i + 1) * 3600 * 1000 * 8); // Spread across last few days
      const mockIp = `192.168.1.${10 + i}`;
      const ipHash = crypto.createHash("sha256").update(mockIp).digest("hex");

      const answers: Record<string, any> = {};

      // Fill values for all fields in the form
      for (const field of form.fields) {
        if (field.deleted) continue;

        let val: any;
        switch (field.type) {
          case "short_text":
            val = field.label.toLowerCase().includes("role") ? "Senior Developer" : name;
            break;
          case "long_text":
            val = sampleBios[i % sampleBios.length];
            break;
          case "email":
            val = email;
            break;
          case "phone":
            val = `+1${Math.floor(2000000000 + Math.random() * 8000000000)}`;
            break;
          case "number":
            val = Math.floor(3 + Math.random() * 12);
            break;
          case "date":
            val = new Date(Date.now() - i * 86400000).toISOString().split("T")[0];
            break;
          case "dropdown":
            val = field.options && field.options.length > 0 ? field.options[i % field.options.length] : "Option A";
            break;
          case "multiple_choice":
            val = field.options && field.options.length > 0 ? field.options[i % field.options.length] : "Full-Time";
            break;
          case "checkbox":
            val = field.options && field.options.length > 0 ? [field.options[0], field.options[1]].filter(Boolean) : ["TypeScript"];
            break;
          case "file_upload": {
            // Generate real sample physical file & Upload metadata
            const sample = sampleFilesData[(i + form.fields.indexOf(field)) % sampleFilesData.length];
            const fileBasename = `${respIdObj.toString()}_${sample.name}`;

            const relativePath = path.join(
              workspace._id.toString(),
              form._id.toString(),
              "responses",
              responseIdStr,
              fileBasename
            );

            const fullPhysicalPath = path.resolve(uploadDir, relativePath);
            fs.mkdirSync(path.dirname(fullPhysicalPath), { recursive: true });
            fs.writeFileSync(fullPhysicalPath, sample.content);

            const uploadDoc = await Upload.create({
              name: sample.name,
              size: Buffer.byteLength(sample.content),
              type: sample.type,
              path: relativePath,
              owner: user._id,
              uploadTime: submittedAt,
              isBranding: false,
            });

            const safeUrl = `http://localhost:5000/api/upload/file/${relativePath.replace(/\\/g, "/")}`;

            val = {
              fileName: safeUrl,
              fileSize: uploadDoc.size,
              mimeType: uploadDoc.type,
              uploadId: uploadDoc._id.toString(),
            };
            break;
          }
          default:
            val = `Sample Value ${i + 1}`;
        }

        // Set dual keys: by label and by fieldId / _id
        answers[field.label] = val;
        if (field.fieldId) {
          answers[field.fieldId] = val;
        }
        if ((field as any)._id) {
          answers[(field as any)._id.toString()] = val;
        }
      }

      const newResponse = await ResponseModel.create({
        _id: respIdObj,
        formId: form._id,
        answers: answers,
        status: status,
        submittedAt: submittedAt,
        ipHash: ipHash,
        createdAt: submittedAt,
        updatedAt: submittedAt,
      });

      console.log(`  ✅ [${i + 1}/5] Created Response ID: ${newResponse._id} | Status: ${status} | Applicant: ${name}`);
    }

    console.log("\n🎉 Successfully seeded 5 responses with file uploads for test@gmail.com!");
    console.log(`📋 Form ID: ${form._id}`);
    console.log(`💼 Workspace ID: ${workspace._id}`);
    process.exit(0);
  } catch (error) {
    console.error("❌ Seeding failed:", error);
    process.exit(1);
  }
};

seedUserResponses();
