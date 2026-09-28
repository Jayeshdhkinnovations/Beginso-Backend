import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import User from "../models/User";
import Workspace from "../models/Workspace";
import Form from "../models/Form";
import ResponseModel from "../models/Response";

dotenv.config();

const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/onboarding";

// Sample applicant/respondent names
const applicantNames = [
  "Alex Rivera", "Sophia Chen", "Marcus Vance", "Elena Rostova", "David Miller",
  "Aaliyah Khan", "Liam O'Connor", "Zoe Takahashi", "Carlos Gomez", "Priya Sharma",
  "Ethan Wright", "Maya Lin", "Benjamin Hayes", "Olivia Kim", "Daniel Kowalski",
  "Isabella Rossi", "Noah Patel", "Emma Watson", "Lucas Silva", "Ava Martinez",
  "Gabriel Santos", "Chloe Dupont", "William Becker", "Mia Kowalczyk", "James Taylor",
  "Charlotte Brown", "Alexander Johnson", "Amelia Williams", "Henry Jones", "Harper Davis"
];

// Sample emails
const applicantEmails = applicantNames.map(name => {
  const parts = name.toLowerCase().split(" ");
  return `${parts[0]}.${parts[1]}@example.com`;
});

// Sample cities/companies
const cities = ["New York", "San Francisco", "London", "Toronto", "Sydney", "Berlin", "Tokyo", "Mumbai", "Singapore", "Chicago"];
const jobTitles = ["Software Engineer", "Product Manager", "UI/UX Designer", "Data Analyst", "DevOps Engineer", "Marketing Lead", "Sales Executive"];
const products = ["Beginso Starter Plan", "Beginso Pro Tier", "Enterprise License", "Custom Add-on Module", "API Suite Subscription"];
const ratingValues = ["5 - Excellent", "4 - Very Good", "3 - Good", "2 - Fair", "1 - Poor"];
const paymentMethods = ["Credit Card (Stripe)", "PayPal", "Bank Transfer", "Crypto (USDC)"];

const seedKingsData = async () => {
  try {
    console.log("🚀 Connecting to MongoDB Atlas...");
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB");

    // 1. Find target user kingsssss027@gmail.com
    const targetEmail = "kingsssss027@gmail.com";
    let user = await User.findOne({ email: new RegExp(`^${targetEmail}$`, "i") });

    if (!user) {
      console.log(`⚠️ User ${targetEmail} not found. Creating user document...`);
      user = await User.create({
        fullName: "king kings",
        email: targetEmail,
        firebaseUid: `uid-${targetEmail.replace(/[^a-z0-9]/gi, "-")}`,
        role: "admin",
        status: "active",
      });
      console.log(`👤 Created user: ${user.email} (${user._id})`);
    } else {
      console.log(`👤 Found user: ${user.fullName} (${user.email}) - ID: ${user._id}`);
    }

    // 2. Find or create workspace for king kings
    let workspace = await Workspace.findOne({ owner: user._id });
    if (!workspace && user.workspaceId) {
      workspace = await Workspace.findById(user.workspaceId);
    }
    if (!workspace) {
      console.log("📁 Workspace not found. Creating 'king kings's Workspace'...");
      workspace = await Workspace.create({
        name: "king kings's Workspace",
        owner: user._id,
        notificationPreferences: {
          newResponseEmail: true,
          weeklyDigestEmail: true,
          productUpdatesEmail: false,
        },
      });
      user.workspaceId = workspace._id as any;
      await user.save();
    }
    console.log(`📁 Target Workspace: ${workspace.name} (${workspace._id})`);

    // 3. Define the 5 target forms from screenshot
    const formsDefinition = [
      {
        title: "Job Application",
        slug: "job-application",
        description: "Submit your application for open positions at our company.",
        fields: [
          { fieldId: "full_name", label: "Full Name", type: "short_text", required: true },
          { fieldId: "email", label: "Email Address", type: "email", required: true },
          { fieldId: "phone", label: "Phone Number", type: "phone", required: true },
          { fieldId: "position", label: "Position Applied For", type: "dropdown", required: true, options: jobTitles },
          { fieldId: "experience", label: "Years of Experience", type: "number", required: true },
          { fieldId: "bio", label: "Cover Letter / Bio", type: "long_text", required: true },
        ]
      },
      {
        title: "Product Order Form",
        slug: "product-order-form",
        description: "Place your order for Beginso products and services.",
        fields: [
          { fieldId: "customer_name", label: "Customer Name", type: "short_text", required: true },
          { fieldId: "contact_email", label: "Contact Email", type: "email", required: true },
          { fieldId: "product_selected", label: "Select Product", type: "dropdown", required: true, options: products },
          { fieldId: "quantity", label: "Quantity", type: "number", required: true },
          { fieldId: "payment_method", label: "Payment Method", type: "multiple_choice", required: true, options: paymentMethods },
          { fieldId: "special_instructions", label: "Special Delivery Instructions", type: "long_text", required: true }
        ]
      },
      {
        title: "Customer Feedback Survey",
        slug: "customer-feedback-survey",
        description: "Help us improve by rating your experience with our platform.",
        fields: [
          { fieldId: "respondent_name", label: "Your Name", type: "short_text", required: true },
          { fieldId: "overall_rating", label: "Overall Satisfaction", type: "dropdown", required: true, options: ratingValues },
          { fieldId: "features_liked", label: "What features did you enjoy most?", type: "checkbox", required: true, options: ["Form Builder", "Analytics Dashboard", "Speed & Performance", "Customer Support", "Export Tools"] },
          { fieldId: "recommend", label: "Would you recommend Beginso to colleagues?", type: "multiple_choice", required: true, options: ["Definitely Yes", "Probably Yes", "Not Sure", "No"] },
          { fieldId: "feedback_text", label: "Detailed Feedback & Suggestions", type: "long_text", required: true }
        ]
      },
      {
        title: "Contact Information Form",
        slug: "contact-information-form",
        description: "Get in touch with our team for inquiries and support.",
        fields: [
          { fieldId: "contact_name", label: "Your Name", type: "short_text", required: true },
          { fieldId: "contact_email", label: "Email Address", type: "email", required: true },
          { fieldId: "subject", label: "Subject", type: "short_text", required: true },
          { fieldId: "preferred_contact_time", label: "Preferred Contact Time", type: "dropdown", required: true, options: ["Morning (9 AM - 12 PM)", "Afternoon (12 PM - 5 PM)", "Evening (5 PM - 8 PM)"] },
          { fieldId: "message", label: "Message", type: "long_text", required: true }
        ]
      },
      {
        title: "Event Registration",
        slug: "event-registration",
        description: "Register your attendance for the upcoming Beginso Product Summit 2026.",
        fields: [
          { fieldId: "attendee_name", label: "Attendee Name", type: "short_text", required: true },
          { fieldId: "work_email", label: "Work Email", type: "email", required: true },
          { fieldId: "company_name", label: "Company / Organization", type: "short_text", required: true },
          { fieldId: "ticket_type", label: "Ticket Pass Type", type: "multiple_choice", required: true, options: ["General Admission (Free)", "VIP Pass ($199)", "Workshop Pass ($299)"] },
          { fieldId: "dietary_req", label: "Dietary Restrictions", type: "checkbox", required: true, options: ["Vegetarian", "Vegan", "Gluten-Free", "Halal", "None"] }
        ]
      }
    ];

    const formsMap: Record<string, any> = {};

    // 4. Ensure all 5 forms exist under king kings's workspace
    for (const formDef of formsDefinition) {
      let existingForm: any = await Form.findOne({
        workspaceId: workspace._id,
        title: new RegExp(`^${formDef.title}$`, "i")
      });

      if (!existingForm) {
        console.log(`📝 Form '${formDef.title}' not found in workspace. Creating now...`);
        const pageId = new mongoose.Types.ObjectId().toString();
        
        // Build form fields array
        const fields = formDef.fields.map((f, idx) => ({
          fieldId: f.fieldId,
          type: f.type as any,
          label: f.label,
          required: f.required,
          order: idx,
          pageId: pageId,
          options: f.options ? f.options.map(opt => ({ label: opt, value: opt })) : undefined
        }));

        existingForm = await Form.create({
          title: formDef.title,
          description: formDef.description,
          workspaceId: workspace._id,
          status: "published",
          slug: `${formDef.slug}-${user._id.toString().slice(-4)}`,
          publishedSlug: `${formDef.slug}-${user._id.toString().slice(-4)}`,
          publishedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          pages: [{ id: pageId, order: 0, title: "Page 1", description: "Form fields" }],
          fields: fields as any,
          schemaVersion: 1
        });
        console.log(`✨ Created form '${existingForm.title}' (${existingForm._id})`);
      } else {
        console.log(`📄 Existing form '${existingForm.title}' (${existingForm._id})`);
      }
      formsMap[formDef.title] = existingForm;
    }

    // 5. Seed responses across a 30-day timeline (July 12, 2026 to August 11, 2026)
    console.log("\n🌱 Seeding FULLY COMPLETED timeline responses across past 30 days...");

    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const startDate = now - thirtyDaysMs;

    // Clear existing responses for these forms first to give a clean, perfect dataset
    const allFormIds = Object.values(formsMap).map(f => f._id);
    const deleteResult = await ResponseModel.deleteMany({ formId: { $in: allFormIds } });
    console.log(`🧹 Cleaned up ${deleteResult.deletedCount} previous test responses.`);

    let totalCreatedResponses = 0;

    // Define response count target per form (25 to 35 responses per form)
    const formResponseTargets = [
      { title: "Job Application", count: 28 },
      { title: "Product Order Form", count: 32 },
      { title: "Customer Feedback Survey", count: 35 },
      { title: "Contact Information Form", count: 24 },
      { title: "Event Registration", count: 30 },
    ];

    for (const target of formResponseTargets) {
      const form = formsMap[target.title];
      if (!form) continue;

      console.log(`⏳ Seeding ${target.count} 100% completed responses for '${form.title}'...`);

      // Generate dates distributed non-uniformly across the 30 days to simulate real user traffic trends
      const dates: Date[] = [];
      for (let i = 0; i < target.count; i++) {
        const randomFraction = Math.pow(Math.random(), 0.85); // slight bias to recent
        const timestamp = startDate + Math.floor(randomFraction * thirtyDaysMs);
        dates.push(new Date(timestamp));
      }
      dates.sort((a, b) => a.getTime() - b.getTime());

      for (let i = 0; i < target.count; i++) {
        const submittedAt = dates[i];
        const applicantName = applicantNames[i % applicantNames.length];
        const applicantEmail = applicantEmails[i % applicantEmails.length];
        const city = cities[i % cities.length];

        // Status is 100% COMPLETED for all test submissions
        const status = "completed" as const;

        // Build answers based on form fields — keying under BOTH label and fieldId to guarantee zero empty fields
        const answers: Record<string, any> = {};

        for (const field of form.fields) {
          let value: any = "";

          if (field.fieldId === "full_name" || field.fieldId === "customer_name" || field.fieldId === "respondent_name" || field.fieldId === "contact_name" || field.fieldId === "attendee_name") {
            value = applicantName;
          } else if (field.fieldId === "email" || field.fieldId === "contact_email" || field.fieldId === "work_email") {
            value = applicantEmail;
          } else if (field.fieldId === "phone") {
            value = `+1 (555) ${100 + (i % 899)}-${1000 + ((i * 37) % 8999)}`;
          } else if (field.fieldId === "position") {
            value = jobTitles[i % jobTitles.length];
          } else if (field.fieldId === "experience") {
            value = (i % 10) + 1;
          } else if (field.fieldId === "bio") {
            value = `Experienced professional based in ${city} with 5+ years expertise in modern software workflows and enterprise delivery.`;
          } else if (field.fieldId === "product_selected") {
            value = products[i % products.length];
          } else if (field.fieldId === "quantity") {
            value = (i % 5) + 1;
          } else if (field.fieldId === "payment_method") {
            value = paymentMethods[i % paymentMethods.length];
          } else if (field.fieldId === "special_instructions") {
            value = `Please deliver to main office location in ${city}. Standard business hours delivery requested.`;
          } else if (field.fieldId === "overall_rating") {
            value = ratingValues[i % ratingValues.length];
          } else if (field.fieldId === "features_liked") {
            value = ["Form Builder", "Analytics Dashboard", "Speed & Performance"].slice(0, (i % 3) + 1);
          } else if (field.fieldId === "recommend") {
            value = i % 4 === 0 ? "Probably Yes" : "Definitely Yes";
          } else if (field.fieldId === "feedback_text") {
            value = `Overall exceptional experience using Beginso. The intuitive form builder and real-time response tables streamlined our entire workflow.`;
          } else if (field.fieldId === "subject") {
            value = `Inquiry regarding enterprise features and licensing - ${applicantName}`;
          } else if (field.fieldId === "preferred_contact_time") {
            value = ["Morning (9 AM - 12 PM)", "Afternoon (12 PM - 5 PM)", "Evening (5 PM - 8 PM)"][i % 3];
          } else if (field.fieldId === "message") {
            value = `Hello team, we are currently evaluating Beginso for our organization of 50+ members. Please reach out to me at ${applicantEmail}.`;
          } else if (field.fieldId === "company_name") {
            value = `${applicantName.split(" ")[1]} Global Solutions Inc.`;
          } else if (field.fieldId === "ticket_type") {
            value = ["General Admission (Free)", "VIP Pass ($199)", "Workshop Pass ($299)"][i % 3];
          } else if (field.fieldId === "dietary_req") {
            value = ["Vegetarian", "Vegan", "Gluten-Free", "None"][i % 4];
          } else if (field.type === "short_text") {
            value = `Sample entry ${i + 1}`;
          } else if (field.type === "email") {
            value = applicantEmail;
          } else if (field.type === "dropdown" && field.options && field.options.length > 0) {
            value = typeof field.options[i % field.options.length] === "string" 
              ? field.options[i % field.options.length] 
              : field.options[i % field.options.length].value || field.options[i % field.options.length].label;
          } else if (field.type === "multiple_choice" && field.options && field.options.length > 0) {
            value = typeof field.options[i % field.options.length] === "string" 
              ? field.options[i % field.options.length] 
              : field.options[i % field.options.length].value || field.options[i % field.options.length].label;
          } else if (field.type === "checkbox" && field.options && field.options.length > 0) {
            const firstOpt = field.options[0];
            value = [typeof firstOpt === "string" ? firstOpt : firstOpt.value || firstOpt.label];
          } else {
            value = `Completed value ${i + 1}`;
          }

          // Populate answers under BOTH field.label AND field.fieldId to ensure 100% field coverage under any lookup
          if (field.label) answers[field.label] = value;
          if (field.fieldId) answers[field.fieldId] = value;
        }

        await ResponseModel.create({
          formId: form._id,
          status,
          answers,
          submittedAt,
          createdAt: submittedAt,
          updatedAt: submittedAt,
        });

        totalCreatedResponses++;
      }
      console.log(`✅ Seeded ${target.count} fully completed responses for '${form.title}'`);
    }

    console.log(`\n🎉 SEEDING COMPLETED SUCCESSFULLY!`);
    console.log(`📊 Summary of 100% Filled-Out Dataset:`);
    console.log(`   - User: ${user.fullName} (${user.email})`);
    console.log(`   - Workspace: ${workspace.name}`);
    console.log(`   - Total Forms: ${Object.keys(formsMap).length}`);
    console.log(`   - Total Completed Responses: ${totalCreatedResponses}`);
    console.log(`   - Date Span: July 12, 2026 ➔ August 11, 2026 (30 Days)`);
    console.log(`   - Empty Fields: 0 (Every single field is 100% populated!)\n`);

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error("❌ Error seeding data:", error);
    process.exit(1);
  }
};

seedKingsData();
