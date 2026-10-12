import mongoose from "mongoose";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import Template from "../models/Template";
import { fieldShowcaseTemplate } from "../utils/fieldShowcaseTemplate";

dotenv.config();

const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/onboarding";

const seedTemplates = async () => {
  try {
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB for seeding");

    // Read seeds.json for pitch template
    let pitchSeedsData: any = { pages: [], fields: [] };
    const seedsPath = path.join(__dirname, "../../seeds.json");
    if (fs.existsSync(seedsPath)) {
      pitchSeedsData = JSON.parse(fs.readFileSync(seedsPath, "utf-8"));
    }

    // Clear existing templates
    await Template.deleteMany({});
    console.log("🗑️ Cleared existing templates");

    const templates = [
      fieldShowcaseTemplate,
      {
        name: "Pitch Plan",
        category: "advanced",
        theme: "classic-light",
        isActive: true,
        pages: pitchSeedsData.pages || [],
        fields: pitchSeedsData.fields || [],
      },
      {
        name: "Contact Information Form",
        category: "General",
        theme: "classic-light",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Identity Details", description: "Please enter your name and comments." },
          { id: "page-2", order: 1, title: "Contact Details", description: "How can we reach you?" }
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Priya Sharma", helpText: "Enter your legal name." },
          { pageId: "page-2", label: "Email Address", type: "email" as const, required: true, placeholder: "e.g. priya@example.com", helpText: "We will send updates here." },
          { pageId: "page-2", label: "Phone Number", type: "phone" as const, required: false, placeholder: "e.g. +919876543210", helpText: "Optional mobile or landline number." },
          { pageId: "page-1", label: "Additional Comments", type: "long_text" as const, required: false, placeholder: "Type any other information...", helpText: "Any other details you want to share." },
        ],
      },
      {
        name: "Customer Feedback Survey",
        category: "Feedback",
        theme: "ocean-breeze",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Rating", description: "Rate your overall satisfaction." },
          { id: "page-2", order: 1, title: "Review Detail", description: "Share your thoughts and recommendation." }
        ],
        fields: [
          { pageId: "page-1", label: "Overall Rating (1-5)", type: "number" as const, required: true, min: 1, max: 5, placeholder: "e.g. 5", helpText: "Rate from 1 (lowest) to 5 (highest)." },
          { pageId: "page-2", label: "What did you like most?", type: "long_text" as const, required: true, placeholder: "Describe your favorite aspect...", helpText: "Be as detailed as you like." },
          { pageId: "page-2", label: "Would you recommend us?", type: "dropdown" as const, required: true, options: ["Yes", "No", "Maybe"], placeholder: "Select option...", helpText: "Select if you would recommend us to others." },
        ],
      },
      {
        name: "Job Application",
        category: "HR",
        theme: "professional-slate",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Personal Details", description: "Basic contact details." },
          { id: "page-2", order: 1, title: "Experience & Availability", description: "Work details and timeline." }
        ],
        fields: [
          { pageId: "page-1", label: "Applicant Name", type: "short_text" as const, required: true, placeholder: "e.g. Rohan Das", helpText: "Your legal full name." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. rohan.das@example.com", helpText: "For communication regarding your application." },
          { pageId: "page-1", label: "Portfolio URL", type: "short_text" as const, required: false, placeholder: "e.g. https://myportfolio.dev", helpText: "Link to your portfolio or GitHub." },
          { pageId: "page-2", label: "Years of Experience", type: "number" as const, required: true, min: 0, placeholder: "e.g. 3", helpText: "Number of full years of professional experience." },
          { pageId: "page-2", label: "Expected Join Date", type: "date" as const, required: true, placeholder: "YYYY-MM-DD", helpText: "When are you available to start?" },
        ],
      },
      {
        name: "Event Registration",
        category: "Events",
        theme: "sunset-glow",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Attendee Info", description: "Who is attending?" },
          { id: "page-2", order: 1, title: "Dietary Preferences", description: "Let us know about food preferences." }
        ],
        fields: [
          { pageId: "page-1", label: "Attendee Name", type: "short_text" as const, required: true, placeholder: "e.g. Amit Kumar", helpText: "Name to print on the badge." },
          { pageId: "page-1", label: "Ticket Type", type: "multiple_choice" as const, required: true, options: ["VIP", "General Admission", "Student"], placeholder: "Select ticket...", helpText: "Select your ticket category." },
          { pageId: "page-2", label: "Dietary Restrictions", type: "checkbox" as const, required: false, options: ["Vegan", "Gluten-Free", "Nut-Free"], placeholder: "Select restriction...", helpText: "Select all that apply." },
        ],
      },
      {
        name: "Product Order Form",
        category: "Sales",
        theme: "forest-emerald",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Item Selection", description: "What would you like to buy?" },
          { id: "page-2", order: 1, title: "Delivery Details", description: "When and where should it go?" }
        ],
        fields: [
          { pageId: "page-1", label: "Product Choice", type: "dropdown" as const, required: true, options: ["Product A", "Product B", "Product C"], placeholder: "Select product...", helpText: "Choose the item you want to order." },
          { pageId: "page-1", label: "Quantity", type: "number" as const, required: true, min: 1, max: 10, placeholder: "e.g. 1", helpText: "Specify quantity (1-10)." },
          { pageId: "page-2", label: "Delivery Date", type: "date" as const, required: true, placeholder: "YYYY-MM-DD", helpText: "Select preferred delivery date." },
          { pageId: "page-2", label: "Delivery Notes", type: "long_text" as const, required: false, placeholder: "Gate codes, directions, etc...", helpText: "Additional delivery instructions." },
        ],
      },
      {
        name: "Master Comprehensive Template",
        category: "General",
        theme: "classic-light",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Personal Information", description: "Let's start with your basic contact details." },
          { id: "page-2", order: 1, title: "Professional Background", description: "Tell us about your work experience and credentials." },
          { id: "page-3", order: 2, title: "Preferences & Uploads", description: "Specify your preferences and upload required documents." }
        ],
        fields: [
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
        ],
      },
    ];

    const inserted = await Template.insertMany(templates);
    console.log(`✅ Successfully seeded ${inserted.length} templates!`);
    process.exit(0);
  } catch (error) {
    console.error("❌ Error seeding templates:", error);
    process.exit(1);
  }
};

seedTemplates();
