import "./_refuseProduction"; // must stay the first import: stops the script before anything else loads
import mongoose from "mongoose";
import dotenv from "dotenv";
import Form from "../models/Form";
import Workspace from "../models/Workspace";
import User from "../models/User";

dotenv.config();

const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/onboarding";

const seedFullForm = async () => {
  try {
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB for seeding full form");

    // 1. Get or create a User and Workspace
    let user = await User.findOne({});
    if (!user) {
      user = await User.create({
        fullName: "System Seed User",
        email: "seed-user@test.com",
        firebaseUid: "seed-firebase-uid-12345",
        role: "admin",
      });
      console.log(`👤 Created user: ${user.email}`);
    }

    let workspace = await Workspace.findOne({ owner: user._id });
    if (!workspace) {
      workspace = await Workspace.create({
        name: "Seed Master Workspace",
        owner: user._id,
      });
      console.log(`📁 Created workspace: ${workspace.name}`);
      user.workspaceId = workspace._id as any;
      await user.save();
    }

    // 2. Create the Form with all 10 field types
    const fullFormTitle = "Comprehensive Master Form";
    // Check if it already exists to avoid duplicates
    const existingForm = await Form.findOne({ title: fullFormTitle });
    if (existingForm) {
      console.log("ℹ️ Form already exists. Deleting it first...");
      await Form.deleteOne({ _id: existingForm._id });
    }

    const formPages = [
      { id: "page-1", order: 0, title: "Personal Information", description: "Let's start with your basic contact details." },
      { id: "page-2", order: 1, title: "Professional Background", description: "Tell us about your work experience and credentials." },
      { id: "page-3", order: 2, title: "Preferences & Uploads", description: "Specify your preferences and upload required documents." }
    ];

    const formFields = [
      // Page 1 fields
      { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, minLength: 3, maxLength: 50, placeholder: "e.g. John Doe", helpText: "Enter your legal name as shown on your passport/ID." },
      { pageId: "page-1", label: "Short Biography", type: "long_text" as const, required: false, minLength: 10, maxLength: 500, placeholder: "Write a brief summary of yourself...", helpText: "Introduce yourself in a few sentences." },
      { pageId: "page-1", label: "Email Address", type: "email" as const, required: true, placeholder: "e.g. john.doe@example.com", helpText: "We will send primary communication to this address." },
      { pageId: "page-1", label: "Mobile Number", type: "phone" as const, required: false, pattern: "^\\+[1-9]\\d{1,14}$", placeholder: "e.g. +12025550193", helpText: "Include your country code starting with '+'." },
      { pageId: "page-1", label: "Age", type: "number" as const, required: true, min: 1, max: 100, placeholder: "e.g. 25", helpText: "Must be 18 years or older to proceed." },
      { pageId: "page-1", label: "Date of Birth", type: "date" as const, required: true, minDate: "1900-01-01", maxDate: "2026-12-31", placeholder: "YYYY-MM-DD", helpText: "Select your date of birth." },
      { pageId: "page-1", label: "Gender Profile", type: "dropdown" as const, required: true, options: ["Male", "Female", "Non-binary", "Prefer not to say"], placeholder: "Select option...", helpText: "Select the option that best fits you." },
      { pageId: "page-1", label: "Marital Status", type: "multiple_choice" as const, required: true, options: ["Single", "Married", "Divorced", "Widowed"], placeholder: "Select option...", helpText: "Please select your current legal marital status." },
      { pageId: "page-1", label: "Contact Preferences", type: "checkbox" as const, required: false, options: ["Email Alerts", "SMS Updates", "Phone Calls", "Postal Mail"], placeholder: "Select option...", helpText: "Select all preferred channels of communication." },
      { pageId: "page-1", label: "Identity Proof Document", type: "file_upload" as const, required: true, maxFileSize: 5, allowedMimeTypes: ["image/jpeg", "image/png"], placeholder: "Select file...", helpText: "Upload a copy of your National ID or Passport." },

      // Page 2 fields
      { pageId: "page-2", label: "Current Job Title", type: "short_text" as const, required: true, minLength: 3, maxLength: 50, placeholder: "e.g. Senior Software Engineer", helpText: "Enter your current professional role." },
      { pageId: "page-2", label: "Key Achievements & Projects", type: "long_text" as const, required: false, minLength: 10, maxLength: 500, placeholder: "Describe key responsibilities and accomplishments...", helpText: "Share some of your proudest accomplishments." },
      { pageId: "page-2", label: "Professional Reference Email", type: "email" as const, required: true, placeholder: "e.g. manager@company.com", helpText: "Email address of your previous supervisor/manager." },
      { pageId: "page-2", label: "Workspace Phone", type: "phone" as const, required: false, pattern: "^\\+[1-9]\\d{1,14}$", placeholder: "e.g. +14155552671", helpText: "Official work contact number." },
      { pageId: "page-2", label: "Years of Experience", type: "number" as const, required: true, min: 0, max: 50, placeholder: "e.g. 5", helpText: "Total number of years working in this industry." },
      { pageId: "page-2", label: "Preferred Start Date", type: "date" as const, required: true, minDate: "2026-01-01", maxDate: "2027-12-31", placeholder: "YYYY-MM-DD", helpText: "Select the earliest date you are available to start." },
      { pageId: "page-2", label: "Highest Education Level", type: "dropdown" as const, required: true, options: ["High School", "Bachelor's Degree", "Master's Degree", "Doctorate"], placeholder: "Select level...", helpText: "Choose your highest achieved degree." },
      { pageId: "page-2", label: "Employment Type Preferred", type: "multiple_choice" as const, required: true, options: ["Full-Time", "Part-Time", "Contract / Freelance", "Internship"], placeholder: "Select option...", helpText: "What type of job arrangement are you seeking?" },
      { pageId: "page-2", label: "Skills Checklist", type: "checkbox" as const, required: false, options: ["Frontend Development", "Backend Systems", "Project Management", "Data Analysis"], placeholder: "Select option...", helpText: "Mark all skills you possess at a professional level." },
      { pageId: "page-2", label: "Professional Resume / CV", type: "file_upload" as const, required: true, maxFileSize: 10, allowedMimeTypes: ["image/jpeg", "image/png"], placeholder: "Select file...", helpText: "Upload your latest CV in PDF or image format." },

          // Page 3 fields
      { pageId: "page-3", label: "Preferred City of Work", type: "short_text" as const, required: true, minLength: 3, maxLength: 50, placeholder: "e.g. San Francisco", helpText: "Specify the city where you would like to be placed." },
      { pageId: "page-3", label: "Office Accommodation Requests", type: "long_text" as const, required: false, minLength: 10, maxLength: 500, placeholder: "Let us know if you require any specific setup...", helpText: "Mention ergonomic or accessibility requests." },
      { pageId: "page-3", label: "Alternate Personal Email", type: "email" as const, required: true, placeholder: "e.g. personal@backup.com", helpText: "In case we cannot reach you on your primary email." },
      { pageId: "page-3", label: "Emergency Contact Phone", type: "phone" as const, required: false, pattern: "^\\+[1-9]\\d{1,14}$", placeholder: "e.g. +15105550182", helpText: "Phone number of a family member or close contact." },
      { pageId: "page-3", label: "Expected Annual Salary ($k)", type: "number" as const, required: true, min: 10, max: 1000, placeholder: "e.g. 120", helpText: "Enter your salary expectations in thousands of dollars." },
      { pageId: "page-3", label: "Background Check Authorization Date", type: "date" as const, required: true, minDate: "2026-01-01", maxDate: "2026-12-31", placeholder: "YYYY-MM-DD", helpText: "Select today's date to authorize background verification." },
      { pageId: "page-3", label: "Preferred Laptop OS", type: "dropdown" as const, required: true, options: ["macOS", "Windows", "Linux (Ubuntu/Debian)", "Other / Bring Your Own"], placeholder: "Select OS...", helpText: "Choose your primary development operating system." },
      { pageId: "page-3", label: "Relocation Status", type: "multiple_choice" as const, required: true, options: ["Yes, immediately", "Yes, with financial support", "No, remote work only", "Undecided"], placeholder: "Select option...", helpText: "Would you be willing to relocate for this position?" },
      { pageId: "page-3", label: "Language Proficiencies", type: "checkbox" as const, required: false, options: ["English", "Spanish", "French", "German"], placeholder: "Select option...", helpText: "Select all languages you speak fluently." },
      { pageId: "page-3", label: "Reference Letter", type: "file_upload" as const, required: true, maxFileSize: 5, allowedMimeTypes: ["image/jpeg", "image/png"], placeholder: "Select file...", helpText: "Upload a recommendation or reference letter." }
    ];

    const form = await Form.create({
      title: fullFormTitle,
      description: "A comprehensive long-form master template featuring 3 pages and all 10 supported field types with custom placeholders and help texts on each page.",
      workspaceId: workspace._id,
      status: "published",
      slug: "master-comprehensive-form-slug",
      publishedSlug: "master-comprehensive-form-slug",
      publishedAt: new Date(),
      fields: formFields,
      pages: formPages,
      schemaVersion: 1,
      settings: {
        honeypotEnabled: true,
        layout: "single_column"
      }
    });

    console.log(`✅ Successfully seeded form: "${form.title}" into database!`);
    process.exit(0);
  } catch (error) {
    console.error("❌ Error seeding form:", error);
    process.exit(1);
  }
};

seedFullForm();
