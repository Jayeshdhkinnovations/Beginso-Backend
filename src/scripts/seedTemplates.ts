import mongoose from "mongoose";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import Template from "../models/Template";
import { fieldShowcaseTemplate } from "../utils/fieldShowcaseTemplate";
import { kalaChasmaTemplate } from "../data/kalaChasmaTemplate";
import { refuseInProduction } from "./_guard";

dotenv.config();

const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/onboarding";

const seedTemplates = async () => {
  refuseInProduction("replace the built-in templates");
  try {
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB for seeding");

    // Read seeds.json for pitch template
    let pitchSeedsData: any = { pages: [], fields: [] };
    const seedsPath = path.join(__dirname, "../../seeds.json");
    if (fs.existsSync(seedsPath)) {
      pitchSeedsData = JSON.parse(fs.readFileSync(seedsPath, "utf-8"));
    }

    // Clear the BUILT-IN templates only (workspaceId null). Templates a workspace published (workspaceId set) are never touched.
    const removed = await Template.deleteMany({ workspaceId: null });
    console.log(`🗑️ Cleared ${removed.deletedCount} built-in templates (workspace templates are kept)`);

    const templates = [
      fieldShowcaseTemplate,
      kalaChasmaTemplate,
      {
        name: "Pitch Plan",
        category: "advanced",
        theme: "classic-light",
        isActive: true,
        pages: pitchSeedsData.pages || [],
        fields: pitchSeedsData.fields || [],
      },
      // ─── Lead Generation (indigo, Manrope) ──────────────────────────────────
      {
        name: "Free Trial Request",
        category: "Lead Generation",
        description: "Capture a qualified lead before they start a free trial of your product.",
        theme: "free-trial-request",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Tell us about your team", description: "A few details so we can set up your trial." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Ananya Rao", helpText: "Your first and last name." },
          { pageId: "page-1", label: "Work Email", type: "email" as const, required: true, placeholder: "e.g. ananya@company.com", helpText: "Use your work email so we can verify your company." },
          { pageId: "page-1", label: "Company Name", type: "short_text" as const, required: true, placeholder: "e.g. Acme Inc.", helpText: "The company you're evaluating us for." },
          { pageId: "page-1", label: "Company Size", type: "dropdown" as const, required: true, options: ["1-10", "11-50", "51-200", "201-1000", "1000+"], placeholder: "Select size...", helpText: "Approximate number of employees." },
          { pageId: "page-1", label: "Phone Number", type: "phone" as const, required: false, placeholder: "e.g. +1 415 555 0100", helpText: "Optional, in case we need to reach you." },
        ],
        settings: { layout: "compact", successMessage: "Your trial is on its way — check your inbox for setup instructions." },
        branding: { primaryColor: "#4f46e5", fontFamily: "manrope", panelTreatment: "gradient", backgroundStyle: "mesh", cardStyle: "elevated", buttonStyle: "solid", buttonRadius: "16px", formWidth: "standard", spacing: "comfortable" },
      },
      {
        name: "Newsletter Signup",
        category: "Lead Generation",
        description: "A one-field-at-a-time signup for a product newsletter or mailing list.",
        theme: "newsletter-signup",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Stay in the loop", description: "No spam — just product news and the occasional offer." },
        ],
        fields: [
          { pageId: "page-1", label: "Email Address", type: "email" as const, required: true, placeholder: "e.g. you@example.com", helpText: "Where we'll send the newsletter." },
          { pageId: "page-1", label: "First Name", type: "short_text" as const, required: false, placeholder: "e.g. Sam", helpText: "So we can say hello properly." },
          { pageId: "page-1", label: "Topics of Interest", type: "checkbox" as const, required: false, options: ["Product updates", "Industry news", "Events & webinars", "Tips & tutorials"], placeholder: "Select topics...", helpText: "Pick as many as you like." },
        ],
        settings: { layout: "chat", successMessage: "You're subscribed! Look out for our next issue." },
        branding: { primaryColor: "#4f46e5", fontFamily: "manrope", panelTreatment: "solid", backgroundStyle: "wash", cardStyle: "soft", buttonStyle: "solid", buttonRadius: "16px", formWidth: "narrow", spacing: "compact" },
      },
      {
        name: "Contact Sales",
        category: "Lead Generation",
        description: "Route a high-intent visitor straight to your sales team with the context they need.",
        theme: "contact-sales",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Tell us about you", description: "Who we'll be talking to." },
          { id: "page-2", order: 1, title: "What you're looking for", description: "So the right person reaches out." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Diego Fernandez", helpText: "Your first and last name." },
          { pageId: "page-1", label: "Work Email", type: "email" as const, required: true, placeholder: "e.g. diego@company.com", helpText: "We'll reply here." },
          { pageId: "page-1", label: "Company", type: "short_text" as const, required: true, placeholder: "e.g. Acme Inc.", helpText: "The company you represent." },
          { pageId: "page-2", label: "Budget Range", type: "dropdown" as const, required: false, options: ["Under $5k", "$5k-$20k", "$20k-$100k", "Over $100k"], placeholder: "Select range...", helpText: "Helps us recommend the right plan." },
          { pageId: "page-2", label: "What are you looking to solve?", type: "long_text" as const, required: true, placeholder: "Tell us a bit about your use case...", helpText: "A few sentences is plenty." },
        ],
        settings: { layout: "split_feature", successMessage: "Thanks — a member of our sales team will reach out within one business day." },
        branding: { primaryColor: "#4f46e5", fontFamily: "manrope", panelTreatment: "gradient", backgroundStyle: "gradient", cardStyle: "elevated", buttonStyle: "solid", buttonRadius: "8px", formWidth: "wide", spacing: "comfortable" },
      },

      // ─── E-commerce (orange, Poppins) ───────────────────────────────────────
      {
        name: "Product Order Form",
        category: "E-commerce",
        description: "Take a direct product order with shipping details, built for a small catalog.",
        theme: "product-order-form",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "What are you ordering?", description: "Pick your item and quantity." },
          { id: "page-2", order: 1, title: "Where should it go?", description: "Shipping details." },
        ],
        fields: [
          { pageId: "page-1", label: "Product", type: "dropdown" as const, required: true, options: ["Classic Tee", "Hoodie", "Cap", "Tote Bag"], placeholder: "Select product...", helpText: "Choose the item you'd like to order." },
          { pageId: "page-1", label: "Quantity", type: "number" as const, required: true, min: 1, max: 20, placeholder: "e.g. 2", helpText: "How many you'd like." },
          { pageId: "page-2", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Maria Gomez", helpText: "Name for the shipping label." },
          { pageId: "page-2", label: "Shipping Address", type: "address" as const, required: true, placeholder: "Street, city, postal code, country", helpText: "Where we should deliver your order." },
          { pageId: "page-2", label: "Special Instructions", type: "long_text" as const, required: false, placeholder: "Gate code, delivery window, etc...", helpText: "Anything the courier should know." },
        ],
        settings: { layout: "classic", successMessage: "Order received! You'll get a confirmation email with tracking shortly." },
        branding: { primaryColor: "#ea580c", fontFamily: "poppins", panelTreatment: "solid", backgroundStyle: "wash", cardStyle: "soft", buttonStyle: "solid", buttonRadius: "8px", formWidth: "standard", spacing: "comfortable" },
      },
      {
        name: "Return & Exchange Request",
        category: "E-commerce",
        description: "Let a customer start a return or exchange with a photo of the item's condition.",
        theme: "return-exchange-request",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Your order", description: "Find your order." },
          { id: "page-2", order: 1, title: "What happened?", description: "Tell us why you're returning it." },
        ],
        fields: [
          { pageId: "page-1", label: "Order Number", type: "short_text" as const, required: true, placeholder: "e.g. ORD-10234", helpText: "Found in your confirmation email." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. you@example.com", helpText: "The email used for the order." },
          { pageId: "page-2", label: "Reason for Return", type: "dropdown" as const, required: true, options: ["Wrong size", "Damaged item", "Not as described", "Changed my mind", "Other"], placeholder: "Select reason...", helpText: "Closest match is fine." },
          { pageId: "page-2", label: "Item Condition", type: "multiple_choice" as const, required: true, options: ["Unopened", "Opened, unused", "Used"], placeholder: "Select condition...", helpText: "Helps us process your return faster." },
          { pageId: "page-2", label: "Photo of the Item", type: "image_upload" as const, required: false, maxFileSize: 10, allowedMimeTypes: ["image/jpeg", "image/png"], placeholder: "Upload a photo...", helpText: "Especially helpful for damaged items." },
        ],
        settings: { layout: "steps", successMessage: "Your return request is in — we'll email your return label shortly." },
        branding: { primaryColor: "#ea580c", fontFamily: "poppins", panelTreatment: "pattern", backgroundStyle: "dots", cardStyle: "bordered", buttonStyle: "solid", buttonRadius: "4px", formWidth: "standard", spacing: "comfortable" },
      },
      {
        name: "Product Waitlist",
        category: "E-commerce",
        description: "A quick signup for a sold-out or upcoming product restock.",
        theme: "product-waitlist",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Get notified", description: "We'll let you know the moment it's back." },
        ],
        fields: [
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. you@example.com", helpText: "Where we'll send the notification." },
          { pageId: "page-1", label: "Product Interested In", type: "dropdown" as const, required: true, options: ["Classic Tee", "Hoodie", "Cap", "Tote Bag"], placeholder: "Select product...", helpText: "Which item you're waiting for." },
          { pageId: "page-1", label: "Notify Me By", type: "multiple_choice" as const, required: false, options: ["Email", "SMS"], placeholder: "Select option...", helpText: "How you'd like to hear from us." },
        ],
        settings: { layout: "compact", successMessage: "You're on the list — we'll email you the moment it's back in stock." },
        branding: { primaryColor: "#ea580c", fontFamily: "poppins", panelTreatment: "solid", backgroundStyle: "plain", cardStyle: "flat", buttonStyle: "solid", buttonRadius: "16px", formWidth: "narrow", spacing: "compact" },
      },

      // ─── Feedback & Surveys (teal, Inter) ───────────────────────────────────
      {
        name: "Customer Satisfaction Survey",
        category: "Feedback",
        description: "A short post-purchase survey covering overall rating and open feedback.",
        theme: "customer-satisfaction-survey",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Rate your experience", description: "How did we do?" },
          { id: "page-2", order: 1, title: "Tell us more", description: "What stood out, good or bad." },
        ],
        fields: [
          { pageId: "page-1", label: "Overall Satisfaction", type: "rating" as const, required: true, placeholder: "Select a rating...", helpText: "1 star is poor, 5 stars is excellent." },
          { pageId: "page-2", label: "What did you like most?", type: "long_text" as const, required: false, placeholder: "Describe your favorite part...", helpText: "Optional, but we read every response." },
          { pageId: "page-2", label: "What could we improve?", type: "long_text" as const, required: false, placeholder: "Tell us what fell short...", helpText: "Be as specific as you like." },
          { pageId: "page-2", label: "Would you recommend us?", type: "yes_no" as const, required: true, placeholder: "Select an answer...", helpText: "To a friend or colleague." },
        ],
        settings: { layout: "guided", successMessage: "Thanks for the feedback — it genuinely helps us improve." },
        branding: { primaryColor: "#0d9488", fontFamily: "inter", panelTreatment: "gradient", backgroundStyle: "gradient", cardStyle: "soft", buttonStyle: "solid", buttonRadius: "16px", formWidth: "standard", spacing: "comfortable" },
      },
      {
        name: "Net Promoter Score",
        category: "Feedback",
        description: "A single-question NPS survey with an optional follow-up.",
        theme: "net-promoter-score",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "One quick question", description: "It takes ten seconds." },
        ],
        fields: [
          { pageId: "page-1", label: "How likely are you to recommend us?", type: "rating" as const, required: true, placeholder: "Select a rating...", helpText: "1 is not at all likely, 5 is extremely likely." },
          { pageId: "page-1", label: "What's the main reason for your score?", type: "long_text" as const, required: false, placeholder: "A sentence or two is plenty...", helpText: "Optional." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: false, placeholder: "e.g. you@example.com", helpText: "Only if you'd like us to follow up." },
        ],
        settings: { layout: "compact", successMessage: "Thank you for the score — we read every response." },
        branding: { primaryColor: "#0d9488", fontFamily: "inter", panelTreatment: "solid", backgroundStyle: "wash", cardStyle: "flat", buttonStyle: "solid", buttonRadius: "8px", formWidth: "narrow", spacing: "compact" },
      },
      {
        name: "Website Feedback",
        category: "Feedback",
        description: "A lightweight form for visitors to flag issues or suggest improvements to your site.",
        theme: "website-feedback",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "How was your visit?", description: "Help us improve the site." },
        ],
        fields: [
          { pageId: "page-1", label: "Overall Rating", type: "rating" as const, required: true, placeholder: "Select a rating...", helpText: "How would you rate your experience?" },
          { pageId: "page-1", label: "Was it easy to find what you needed?", type: "yes_no" as const, required: true, placeholder: "Select an answer...", helpText: "Be honest — it helps." },
          { pageId: "page-1", label: "Suggestions", type: "long_text" as const, required: false, placeholder: "What should we fix or add?", helpText: "Optional, but welcome." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: false, placeholder: "e.g. you@example.com", helpText: "Only if you'd like a reply." },
        ],
        settings: { layout: "classic", successMessage: "Thanks for the feedback — we'll put it to good use." },
        branding: { primaryColor: "#0d9488", fontFamily: "inter", panelTreatment: "pattern", backgroundStyle: "dots", cardStyle: "bordered", buttonStyle: "outline", buttonRadius: "8px", formWidth: "standard", spacing: "comfortable" },
      },

      // ─── HR & Hiring (sky blue, Work Sans) ───────────────────────────────────
      {
        name: "Job Application",
        category: "HR",
        description: "Collect a candidate's details, resume and portfolio for an open role.",
        theme: "job-application",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Your details", description: "Basic contact information." },
          { id: "page-2", order: 1, title: "Experience", description: "Tell us about your background." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Noah Williams", helpText: "Your legal full name." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. noah@example.com", helpText: "We'll use this to contact you." },
          { pageId: "page-1", label: "Phone", type: "phone" as const, required: true, placeholder: "e.g. +1 212 555 0138", helpText: "A number we can reach you on." },
          { pageId: "page-1", label: "Position Applying For", type: "dropdown" as const, required: true, options: ["Software Engineer", "Product Designer", "Marketing Manager", "Customer Support"], placeholder: "Select role...", helpText: "The role you're applying to." },
          { pageId: "page-2", label: "Resume / CV", type: "file_upload" as const, required: true, maxFileSize: 10, allowedMimeTypes: ["application/pdf"], placeholder: "Upload your resume...", helpText: "PDF, up to 10MB." },
          { pageId: "page-2", label: "Portfolio or LinkedIn URL", type: "url" as const, required: false, placeholder: "e.g. https://linkedin.com/in/you", helpText: "Optional, but helpful." },
          { pageId: "page-2", label: "Why do you want to work here?", type: "long_text" as const, required: false, placeholder: "A short cover note...", helpText: "Optional." },
        ],
        settings: { layout: "steps", successMessage: "Your application is in — our hiring team will review it and be in touch." },
        branding: { primaryColor: "#0369a1", fontFamily: "work_sans", panelTreatment: "pattern", backgroundStyle: "dots", cardStyle: "bordered", buttonStyle: "solid", buttonRadius: "8px", formWidth: "standard", spacing: "comfortable" },
      },
      {
        name: "Employee Onboarding",
        category: "HR",
        description: "Collect the details a new hire needs to confirm before their first day.",
        theme: "employee-onboarding",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Welcome aboard", description: "A few details before you start." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Priya Sharma", helpText: "As it should appear on your records." },
          { pageId: "page-1", label: "Personal Email", type: "email" as const, required: true, placeholder: "e.g. priya@example.com", helpText: "We'll use this until your work email is ready." },
          { pageId: "page-1", label: "Start Date", type: "date" as const, required: true, placeholder: "Select a date...", helpText: "Your confirmed first day." },
          { pageId: "page-1", label: "Emergency Contact Name", type: "short_text" as const, required: true, placeholder: "e.g. Raj Sharma", helpText: "Who we should contact in an emergency." },
          { pageId: "page-1", label: "Emergency Contact Phone", type: "phone" as const, required: true, placeholder: "e.g. +91 98765 43210", helpText: "A number for that contact." },
          { pageId: "page-1", label: "T-Shirt Size", type: "dropdown" as const, required: false, options: ["XS", "S", "M", "L", "XL", "XXL"], placeholder: "Select size...", helpText: "For your welcome kit." },
        ],
        settings: { layout: "classic", successMessage: "Thanks! Your details are on file — see you on your first day." },
        branding: { primaryColor: "#0369a1", fontFamily: "work_sans", panelTreatment: "solid", backgroundStyle: "wash", cardStyle: "soft", buttonStyle: "solid", buttonRadius: "8px", formWidth: "standard", spacing: "comfortable" },
      },
      {
        name: "Exit Interview",
        category: "HR",
        description: "A structured departure survey to understand why an employee is leaving.",
        theme: "exit-interview",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Before you go", description: "Your feedback helps us improve." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Sofia Russo", helpText: "Your name on record." },
          { pageId: "page-1", label: "Department", type: "dropdown" as const, required: true, options: ["Engineering", "Sales", "Marketing", "Operations", "Support"], placeholder: "Select department...", helpText: "The team you're part of." },
          { pageId: "page-1", label: "Last Working Day", type: "date" as const, required: true, placeholder: "Select a date...", helpText: "Your confirmed last day." },
          { pageId: "page-1", label: "Primary Reason for Leaving", type: "dropdown" as const, required: true, options: ["New opportunity", "Compensation", "Work-life balance", "Relocation", "Other"], placeholder: "Select reason...", helpText: "Closest match is fine." },
          { pageId: "page-1", label: "What could we have done better?", type: "long_text" as const, required: false, placeholder: "Be as candid as you'd like...", helpText: "This stays with HR." },
        ],
        settings: { layout: "guided", successMessage: "Thank you for your honesty — and for your time with us." },
        branding: { primaryColor: "#0369a1", fontFamily: "work_sans", panelTreatment: "solid", backgroundStyle: "plain", cardStyle: "flat", buttonStyle: "outline", buttonRadius: "4px", formWidth: "standard", spacing: "comfortable" },
      },

      // ─── Events & RSVP (violet, Nunito) ──────────────────────────────────────
      {
        name: "Event Registration",
        category: "Events",
        description: "Register attendees for a conference or ticketed event, with dietary needs.",
        theme: "event-registration",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Attendee details", description: "Who's coming?" },
          { id: "page-2", order: 1, title: "A few extras", description: "Helps us plan the day." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Liam Chen", helpText: "Name to print on your badge." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. liam@example.com", helpText: "We'll send your ticket here." },
          { pageId: "page-1", label: "Phone", type: "phone" as const, required: false, placeholder: "e.g. +1 312 555 0144", helpText: "Optional, for day-of updates." },
          { pageId: "page-2", label: "Ticket Type", type: "dropdown" as const, required: true, options: ["General Admission", "VIP", "Student"], placeholder: "Select ticket...", helpText: "Choose your ticket category." },
          { pageId: "page-2", label: "Dietary Restrictions", type: "checkbox" as const, required: false, options: ["Vegetarian", "Vegan", "Gluten-Free", "Nut-Free"], placeholder: "Select restrictions...", helpText: "Select all that apply." },
          { pageId: "page-2", label: "Number of Guests", type: "number" as const, required: false, min: 0, max: 5, placeholder: "e.g. 1", helpText: "Guests joining you, if any." },
        ],
        settings: { layout: "split_feature", successMessage: "You're registered! Your ticket is on its way by email." },
        branding: { primaryColor: "#7c3aed", fontFamily: "nunito", panelTreatment: "gradient", backgroundStyle: "mesh", cardStyle: "elevated", buttonStyle: "solid", buttonRadius: "16px", formWidth: "wide", spacing: "comfortable" },
      },
      {
        name: "Wedding RSVP",
        category: "Events",
        description: "A warm, personal RSVP for a wedding, with meal choice and a song request.",
        theme: "wedding-rsvp",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Will you join us?", description: "We'd love to celebrate with you." },
        ],
        fields: [
          { pageId: "page-1", label: "Guest Name", type: "short_text" as const, required: true, placeholder: "e.g. Isabella Moreau", helpText: "Your full name, as on the invitation." },
          { pageId: "page-1", label: "Will you attend?", type: "yes_no" as const, required: true, placeholder: "Select an answer...", helpText: "We understand if you can't make it." },
          { pageId: "page-1", label: "Number of Guests", type: "number" as const, required: false, min: 1, max: 4, placeholder: "e.g. 2", helpText: "Including yourself." },
          { pageId: "page-1", label: "Meal Choice", type: "dropdown" as const, required: false, options: ["Chicken", "Fish", "Vegetarian", "Vegan"], placeholder: "Select meal...", helpText: "For the reception dinner." },
          { pageId: "page-1", label: "Song Request", type: "short_text" as const, required: false, placeholder: "e.g. anything by Stevie Wonder", helpText: "We'll try to make it happen." },
        ],
        settings: { layout: "card_stack", successMessage: "Thank you — we can't wait to celebrate with you!" },
        branding: { primaryColor: "#7c3aed", fontFamily: "playfair_display", panelTreatment: "gradient", backgroundStyle: "gradient", cardStyle: "elevated", buttonStyle: "solid", buttonRadius: "16px", formWidth: "standard", spacing: "spacious" },
      },
      {
        name: "Webinar Signup",
        category: "Events",
        description: "A fast signup form for a free webinar or online event.",
        theme: "webinar-signup",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Save your seat", description: "Spots are limited." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Grace Kim", helpText: "Your first and last name." },
          { pageId: "page-1", label: "Work Email", type: "email" as const, required: true, placeholder: "e.g. grace@company.com", helpText: "We'll send the join link here." },
          { pageId: "page-1", label: "Job Title", type: "short_text" as const, required: false, placeholder: "e.g. Marketing Lead", helpText: "Optional." },
          { pageId: "page-1", label: "How did you hear about this?", type: "dropdown" as const, required: false, options: ["Social media", "Email", "A colleague", "Search engine", "Other"], placeholder: "Select one...", helpText: "Helps us plan future events." },
        ],
        settings: { layout: "compact", successMessage: "You're registered! We'll email your join link before the event." },
        branding: { primaryColor: "#7c3aed", fontFamily: "nunito", panelTreatment: "solid", backgroundStyle: "wash", cardStyle: "soft", buttonStyle: "solid", buttonRadius: "8px", formWidth: "narrow", spacing: "compact" },
      },

      // ─── Contact Us (blue, DM Sans) ──────────────────────────────────────────
      {
        name: "General Contact Form",
        category: "Contact us",
        description: "A simple, general-purpose contact form for any website.",
        theme: "general-contact-form",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Get in touch", description: "We'll get back to you within a day or two." },
        ],
        fields: [
          { pageId: "page-1", label: "Name", type: "short_text" as const, required: true, placeholder: "e.g. Jordan Lee", helpText: "Your first and last name." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. jordan@example.com", helpText: "We'll reply here." },
          { pageId: "page-1", label: "Subject", type: "dropdown" as const, required: true, options: ["General question", "Partnership", "Press", "Other"], placeholder: "Select subject...", helpText: "Helps route your message." },
          { pageId: "page-1", label: "Message", type: "long_text" as const, required: true, placeholder: "How can we help?", helpText: "Share as much detail as you'd like." },
        ],
        settings: { layout: "classic", successMessage: "Thanks for reaching out — we'll be in touch soon." },
        branding: { primaryColor: "#2563eb", fontFamily: "dm_sans", panelTreatment: "solid", backgroundStyle: "wash", cardStyle: "soft", buttonStyle: "solid", buttonRadius: "8px", formWidth: "standard", spacing: "comfortable" },
      },
      {
        name: "Support Request",
        category: "Contact us",
        description: "A structured support ticket form with priority and a screenshot upload.",
        theme: "support-request",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "What's going on?", description: "The more detail, the faster we can help." },
        ],
        fields: [
          { pageId: "page-1", label: "Name", type: "short_text" as const, required: true, placeholder: "e.g. Taylor Brooks", helpText: "Your first and last name." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. taylor@example.com", helpText: "We'll reply here." },
          { pageId: "page-1", label: "Account or Order ID", type: "short_text" as const, required: false, placeholder: "e.g. ACC-88213", helpText: "If you have one handy." },
          { pageId: "page-1", label: "Issue Type", type: "dropdown" as const, required: true, options: ["Billing", "Bug report", "Feature request", "Account access", "Other"], placeholder: "Select type...", helpText: "Closest match is fine." },
          { pageId: "page-1", label: "Priority", type: "multiple_choice" as const, required: true, options: ["Low", "Normal", "High", "Urgent"], placeholder: "Select priority...", helpText: "How blocking is this for you?" },
          { pageId: "page-1", label: "Describe the Issue", type: "long_text" as const, required: true, placeholder: "What happened, and what did you expect?", helpText: "Steps to reproduce are especially helpful." },
          { pageId: "page-1", label: "Attach a Screenshot", type: "image_upload" as const, required: false, maxFileSize: 10, allowedMimeTypes: ["image/jpeg", "image/png"], placeholder: "Upload a screenshot...", helpText: "Optional, but often clarifies things fast." },
        ],
        settings: { layout: "guided", successMessage: "Your ticket is in — our support team will follow up by email." },
        branding: { primaryColor: "#2563eb", fontFamily: "dm_sans", panelTreatment: "pattern", backgroundStyle: "grid", cardStyle: "bordered", buttonStyle: "solid", buttonRadius: "4px", formWidth: "standard", spacing: "comfortable" },
      },

      // ─── Booking & Reservation (rose, Outfit) ────────────────────────────────
      {
        name: "Appointment Booking",
        category: "Reservation/Booking",
        description: "Let a client request a specific service at a preferred date and time.",
        theme: "appointment-booking",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Book your appointment", description: "Pick a service and a time that works for you." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Hannah Wright", helpText: "Your first and last name." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. hannah@example.com", helpText: "We'll send a confirmation here." },
          { pageId: "page-1", label: "Phone", type: "phone" as const, required: true, placeholder: "e.g. +1 646 555 0112", helpText: "In case we need to reach you." },
          { pageId: "page-1", label: "Service Needed", type: "dropdown" as const, required: true, options: ["Consultation", "Follow-up", "New client intake", "Other"], placeholder: "Select service...", helpText: "Choose the closest match." },
          { pageId: "page-1", label: "Preferred Date", type: "date" as const, required: true, placeholder: "Select a date...", helpText: "We'll confirm availability." },
          { pageId: "page-1", label: "Preferred Time", type: "time" as const, required: true, placeholder: "Select a time...", helpText: "Your ideal appointment time." },
        ],
        settings: { layout: "compact", successMessage: "Request received — we'll confirm your appointment by email." },
        branding: { primaryColor: "#e11d48", fontFamily: "outfit", panelTreatment: "solid", backgroundStyle: "wash", cardStyle: "soft", buttonStyle: "solid", buttonRadius: "16px", formWidth: "narrow", spacing: "comfortable" },
      },
      {
        name: "Table Reservation",
        category: "Reservation/Booking",
        description: "A restaurant-style reservation form with party size and special requests.",
        theme: "table-reservation",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Reserve a table", description: "We look forward to having you." },
        ],
        fields: [
          { pageId: "page-1", label: "Name", type: "short_text" as const, required: true, placeholder: "e.g. Oliver Bennett", helpText: "The name on the reservation." },
          { pageId: "page-1", label: "Phone", type: "phone" as const, required: true, placeholder: "e.g. +1 617 555 0176", helpText: "In case we need to confirm details." },
          { pageId: "page-1", label: "Party Size", type: "number" as const, required: true, min: 1, max: 20, placeholder: "e.g. 4", helpText: "Number of guests, including yourself." },
          { pageId: "page-1", label: "Date", type: "date" as const, required: true, placeholder: "Select a date...", helpText: "The date you'd like to dine." },
          { pageId: "page-1", label: "Time", type: "time" as const, required: true, placeholder: "Select a time...", helpText: "Your preferred arrival time." },
          { pageId: "page-1", label: "Special Requests", type: "long_text" as const, required: false, placeholder: "Allergies, celebrations, seating preference...", helpText: "Optional." },
        ],
        settings: { layout: "classic", successMessage: "Table booked — see you soon!" },
        branding: { primaryColor: "#e11d48", fontFamily: "outfit", panelTreatment: "gradient", backgroundStyle: "gradient", cardStyle: "elevated", buttonStyle: "solid", buttonRadius: "16px", formWidth: "standard", spacing: "comfortable" },
      },
      {
        name: "Venue / Room Booking",
        category: "Reservation/Booking",
        description: "Request a meeting room or event venue for a specific date and time window.",
        theme: "venue-room-booking",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Your event", description: "Tell us about the organization and occasion." },
          { id: "page-2", order: 1, title: "Date and space", description: "When, and how big." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Zainab Ahmed", helpText: "The person organizing the booking." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. zainab@example.com", helpText: "We'll confirm here." },
          { pageId: "page-1", label: "Organization", type: "short_text" as const, required: false, placeholder: "e.g. Acme Inc.", helpText: "Optional, if booking on behalf of a group." },
          { pageId: "page-2", label: "Event Date", type: "date" as const, required: true, placeholder: "Select a date...", helpText: "The date you need the space." },
          { pageId: "page-2", label: "Start Time", type: "time" as const, required: true, placeholder: "Select a time...", helpText: "When the booking starts." },
          { pageId: "page-2", label: "End Time", type: "time" as const, required: true, placeholder: "Select a time...", helpText: "When the booking ends." },
          { pageId: "page-2", label: "Room / Venue", type: "dropdown" as const, required: true, options: ["Small meeting room", "Large meeting room", "Event hall"], placeholder: "Select space...", helpText: "Choose the space you need." },
          { pageId: "page-2", label: "Expected Attendees", type: "number" as const, required: false, min: 1, max: 500, placeholder: "e.g. 20", helpText: "Approximate headcount." },
        ],
        settings: { layout: "steps", successMessage: "Booking request received — we'll confirm availability shortly." },
        branding: { primaryColor: "#e11d48", fontFamily: "outfit", panelTreatment: "pattern", backgroundStyle: "dots", cardStyle: "bordered", buttonStyle: "solid", buttonRadius: "8px", formWidth: "wide", spacing: "comfortable" },
      },

      // ─── Education (emerald, Space Grotesk) ──────────────────────────────────
      {
        name: "Course Enrollment",
        category: "Education",
        description: "Enroll a student in a course, with their education level and how they found you.",
        theme: "course-enrollment",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Enroll now", description: "Reserve your spot in the course." },
          { id: "page-2", order: 1, title: "A bit about you", description: "Helps us tailor the class." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Emeka Okafor", helpText: "Your first and last name." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. emeka@example.com", helpText: "We'll send enrollment details here." },
          { pageId: "page-1", label: "Phone", type: "phone" as const, required: false, placeholder: "e.g. +234 801 234 5678", helpText: "Optional." },
          { pageId: "page-2", label: "Course", type: "dropdown" as const, required: true, options: ["Intro to Design", "Data Fundamentals", "Public Speaking", "Creative Writing"], placeholder: "Select course...", helpText: "The course you'd like to join." },
          { pageId: "page-2", label: "Education Level", type: "dropdown" as const, required: false, options: ["High school", "Undergraduate", "Graduate", "Other"], placeholder: "Select level...", helpText: "Your current or highest level of study." },
          { pageId: "page-2", label: "How did you hear about this course?", type: "dropdown" as const, required: false, options: ["Social media", "A friend", "Search engine", "Other"], placeholder: "Select one...", helpText: "Optional." },
        ],
        settings: { layout: "steps", successMessage: "You're enrolled! Course details are on their way to your inbox." },
        branding: { primaryColor: "#059669", fontFamily: "space_grotesk", panelTreatment: "solid", backgroundStyle: "wash", cardStyle: "soft", buttonStyle: "solid", buttonRadius: "8px", formWidth: "standard", spacing: "comfortable" },
      },
      {
        name: "Scholarship Application",
        category: "Education",
        description: "Collect an applicant's academic record and essay for a scholarship.",
        theme: "scholarship-application",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Your details", description: "Basic academic information." },
          { id: "page-2", order: 1, title: "Your essay", description: "Tell us why you're a strong fit." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Yuki Tanaka", helpText: "Your legal full name." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. yuki@example.com", helpText: "We'll contact you here." },
          { pageId: "page-1", label: "School / University", type: "short_text" as const, required: true, placeholder: "e.g. State University", helpText: "Where you're currently enrolled." },
          { pageId: "page-1", label: "GPA", type: "number" as const, required: false, min: 0, max: 4, placeholder: "e.g. 3.7", helpText: "On a 4.0 scale, if applicable." },
          { pageId: "page-2", label: "Why do you deserve this scholarship?", type: "long_text" as const, required: true, placeholder: "Tell us about your goals and circumstances...", helpText: "There's no strict word limit." },
          { pageId: "page-2", label: "Transcript", type: "file_upload" as const, required: true, maxFileSize: 10, allowedMimeTypes: ["application/pdf"], placeholder: "Upload your transcript...", helpText: "PDF, up to 10MB." },
        ],
        settings: { layout: "guided", successMessage: "Your application is submitted — good luck!" },
        branding: { primaryColor: "#059669", fontFamily: "space_grotesk", panelTreatment: "pattern", backgroundStyle: "dots", cardStyle: "bordered", buttonStyle: "outline", buttonRadius: "4px", formWidth: "wide", spacing: "comfortable" },
      },
      {
        name: "Student Feedback Survey",
        category: "Education",
        description: "Gather end-of-course feedback on the instructor and material.",
        theme: "student-feedback-survey",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "How was the course?", description: "Your feedback shapes the next cohort." },
        ],
        fields: [
          { pageId: "page-1", label: "Course Name", type: "short_text" as const, required: true, placeholder: "e.g. Intro to Design", helpText: "The course you just finished." },
          { pageId: "page-1", label: "Instructor Rating", type: "rating" as const, required: true, placeholder: "Select a rating...", helpText: "How would you rate the instructor?" },
          { pageId: "page-1", label: "What worked well?", type: "long_text" as const, required: false, placeholder: "Pacing, materials, teaching style...", helpText: "Optional." },
          { pageId: "page-1", label: "Suggestions for Improvement", type: "long_text" as const, required: false, placeholder: "What would you change?", helpText: "Optional." },
        ],
        settings: { layout: "compact", successMessage: "Thanks for the feedback — it genuinely shapes future courses." },
        branding: { primaryColor: "#059669", fontFamily: "space_grotesk", panelTreatment: "solid", backgroundStyle: "plain", cardStyle: "flat", buttonStyle: "solid", buttonRadius: "16px", formWidth: "narrow", spacing: "compact" },
      },

      // ─── Real Estate (amber-brown, Merriweather) ─────────────────────────────
      {
        name: "Property Inquiry",
        category: "Real Estate",
        description: "Let a prospective buyer or renter ask about a specific listing.",
        theme: "property-inquiry",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Interested in this property?", description: "Send us your question and we'll follow up." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Carlos Mendoza", helpText: "Your first and last name." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. carlos@example.com", helpText: "We'll reply here." },
          { pageId: "page-1", label: "Phone", type: "phone" as const, required: false, placeholder: "e.g. +1 305 555 0129", helpText: "Optional." },
          { pageId: "page-1", label: "Property Address or Listing ID", type: "short_text" as const, required: true, placeholder: "e.g. 42 Oak Street, or #MLS-10293", helpText: "Which property you're asking about." },
          { pageId: "page-1", label: "Preferred Contact Method", type: "multiple_choice" as const, required: false, options: ["Email", "Phone call", "Text message"], placeholder: "Select method...", helpText: "How you'd like us to reach you." },
          { pageId: "page-1", label: "Your Message", type: "long_text" as const, required: true, placeholder: "What would you like to know?", helpText: "Ask away." },
        ],
        settings: { layout: "classic", successMessage: "Thanks for your interest — an agent will be in touch shortly." },
        branding: { primaryColor: "#b45309", fontFamily: "merriweather", panelTreatment: "solid", backgroundStyle: "wash", cardStyle: "soft", buttonStyle: "solid", buttonRadius: "8px", formWidth: "standard", spacing: "comfortable" },
      },
      {
        name: "Schedule a Viewing",
        category: "Real Estate",
        description: "Let a prospective buyer book a time to tour a property.",
        theme: "schedule-a-viewing",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Book a viewing", description: "Pick a day and time that works for you." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Fatima Al-Sayed", helpText: "Your first and last name." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. fatima@example.com", helpText: "We'll confirm here." },
          { pageId: "page-1", label: "Phone", type: "phone" as const, required: true, placeholder: "e.g. +1 702 555 0188", helpText: "In case we need to reach you." },
          { pageId: "page-1", label: "Property of Interest", type: "dropdown" as const, required: true, options: ["42 Oak Street", "118 Maple Ave", "7 Harbor View"], placeholder: "Select property...", helpText: "Which listing you'd like to view." },
          { pageId: "page-1", label: "Preferred Date", type: "date" as const, required: true, placeholder: "Select a date...", helpText: "Your preferred viewing date." },
          { pageId: "page-1", label: "Preferred Time", type: "time" as const, required: true, placeholder: "Select a time...", helpText: "Your preferred viewing time." },
        ],
        settings: { layout: "compact", successMessage: "Viewing requested — your agent will confirm the time shortly." },
        branding: { primaryColor: "#b45309", fontFamily: "merriweather", panelTreatment: "gradient", backgroundStyle: "gradient", cardStyle: "elevated", buttonStyle: "solid", buttonRadius: "8px", formWidth: "narrow", spacing: "comfortable" },
      },
      {
        name: "Rental Application",
        category: "Real Estate",
        description: "Collect a prospective tenant's income, move-in date and references.",
        theme: "rental-application",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Your details", description: "Contact and current address." },
          { id: "page-2", order: 1, title: "Application details", description: "Income, move-in date and documents." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Aiden Murphy", helpText: "Your legal full name." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. aiden@example.com", helpText: "We'll contact you here." },
          { pageId: "page-1", label: "Phone", type: "phone" as const, required: true, placeholder: "e.g. +1 503 555 0164", helpText: "A number we can reach you on." },
          { pageId: "page-1", label: "Current Address", type: "address" as const, required: true, placeholder: "Street, city, postal code, country", helpText: "Where you live now." },
          { pageId: "page-2", label: "Monthly Income", type: "currency" as const, required: true, min: 0, placeholder: "e.g. 4500", helpText: "Your gross monthly income." },
          { pageId: "page-2", label: "Desired Move-in Date", type: "date" as const, required: true, placeholder: "Select a date...", helpText: "When you'd like to move in." },
          { pageId: "page-2", label: "Do you have pets?", type: "yes_no" as const, required: true, placeholder: "Select an answer...", helpText: "Let us know up front." },
          { pageId: "page-2", label: "Proof of Income", type: "file_upload" as const, required: true, maxFileSize: 10, allowedMimeTypes: ["application/pdf"], placeholder: "Upload a document...", helpText: "A recent pay stub or offer letter, PDF." },
        ],
        settings: { layout: "steps", successMessage: "Application received — we'll review it and follow up within a few days." },
        branding: { primaryColor: "#b45309", fontFamily: "merriweather", panelTreatment: "pattern", backgroundStyle: "dots", cardStyle: "bordered", buttonStyle: "solid", buttonRadius: "4px", formWidth: "wide", spacing: "comfortable" },
      },

      // ─── Non-profit (green, Quicksand) ───────────────────────────────────────
      {
        name: "Volunteer Signup",
        category: "Non-profit",
        description: "Recruit volunteers and learn about their interests and availability.",
        theme: "volunteer-signup",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Join us", description: "Thank you for wanting to help." },
          { id: "page-2", order: 1, title: "How you'd like to help", description: "So we can match you well." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Nadia Petrov", helpText: "Your first and last name." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. nadia@example.com", helpText: "We'll reach out here." },
          { pageId: "page-1", label: "Phone", type: "phone" as const, required: false, placeholder: "e.g. +1 720 555 0199", helpText: "Optional." },
          { pageId: "page-2", label: "Areas of Interest", type: "checkbox" as const, required: false, options: ["Event support", "Fundraising", "Mentoring", "Admin & office help"], placeholder: "Select interests...", helpText: "Select all that apply." },
          { pageId: "page-2", label: "Availability", type: "multiple_choice" as const, required: true, options: ["Weekdays", "Weekends", "Evenings", "Flexible"], placeholder: "Select availability...", helpText: "When you're generally free." },
          { pageId: "page-2", label: "Previous Volunteer Experience", type: "long_text" as const, required: false, placeholder: "Tell us a little about it...", helpText: "Optional." },
        ],
        settings: { layout: "guided", successMessage: "Thank you for signing up — we'll be in touch with next steps." },
        branding: { primaryColor: "#16a34a", fontFamily: "quicksand", panelTreatment: "gradient", backgroundStyle: "gradient", cardStyle: "soft", buttonStyle: "solid", buttonRadius: "16px", formWidth: "standard", spacing: "comfortable" },
      },
      {
        name: "Donation Form",
        category: "Non-profit",
        description: "A simple one-time or recurring donation form, with an optional dedication.",
        theme: "donation-form",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Make a difference", description: "Every contribution helps." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Marcus Johnson", helpText: "Your first and last name." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. marcus@example.com", helpText: "We'll send your receipt here." },
          { pageId: "page-1", label: "Donation Amount", type: "currency" as const, required: true, min: 1, placeholder: "e.g. 50", helpText: "Any amount makes a difference." },
          { pageId: "page-1", label: "Frequency", type: "multiple_choice" as const, required: true, options: ["One-time", "Monthly"], placeholder: "Select frequency...", helpText: "How often you'd like to give." },
          { pageId: "page-1", label: "In Honor or Memory Of", type: "short_text" as const, required: false, placeholder: "e.g. In memory of Grandma Rose", helpText: "Optional dedication." },
        ],
        settings: { layout: "compact", successMessage: "Thank you for your generosity — your receipt is on its way." },
        branding: { primaryColor: "#16a34a", fontFamily: "quicksand", panelTreatment: "solid", backgroundStyle: "wash", cardStyle: "elevated", buttonStyle: "solid", buttonRadius: "16px", formWidth: "narrow", spacing: "comfortable" },
      },
      {
        name: "Fundraising Event Registration",
        category: "Non-profit",
        description: "Register attendees and sponsors for a fundraising gala or charity run.",
        theme: "fundraising-event-registration",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Join the cause", description: "Register for the event." },
          { id: "page-2", order: 1, title: "A few extras", description: "Helps us plan the day." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Olivia Bianchi", helpText: "Your first and last name." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. olivia@example.com", helpText: "We'll send your confirmation here." },
          { pageId: "page-1", label: "Phone", type: "phone" as const, required: false, placeholder: "e.g. +1 619 555 0171", helpText: "Optional." },
          { pageId: "page-2", label: "Number of Tickets", type: "number" as const, required: true, min: 1, max: 10, placeholder: "e.g. 2", helpText: "Including yourself." },
          { pageId: "page-2", label: "Sponsorship Level", type: "dropdown" as const, required: false, options: ["None", "Bronze", "Silver", "Gold", "Platinum"], placeholder: "Select level...", helpText: "Optional — thank you for considering it." },
          { pageId: "page-2", label: "Dietary Restrictions", type: "checkbox" as const, required: false, options: ["Vegetarian", "Vegan", "Gluten-Free"], placeholder: "Select restrictions...", helpText: "Select all that apply." },
        ],
        settings: { layout: "split_feature", successMessage: "You're registered — thank you for supporting the cause." },
        branding: { primaryColor: "#16a34a", fontFamily: "quicksand", panelTreatment: "gradient", backgroundStyle: "mesh", cardStyle: "elevated", buttonStyle: "solid", buttonRadius: "16px", formWidth: "wide", spacing: "comfortable" },
      },

      // ─── Healthcare (cyan, Inter) ────────────────────────────────────────────
      {
        name: "Patient Intake Form",
        category: "Medicine",
        description: "Collect a new patient's contact details, reason for visit and insurance.",
        theme: "patient-intake-form",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Your details", description: "Basic contact information." },
          { id: "page-2", order: 1, title: "Your visit", description: "Why you're here, and who to contact." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Benjamin Okoro", helpText: "Your legal full name." },
          { pageId: "page-1", label: "Date of Birth", type: "date" as const, required: true, placeholder: "Select a date...", helpText: "For your patient record." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. benjamin@example.com", helpText: "We'll send confirmations here." },
          { pageId: "page-1", label: "Phone", type: "phone" as const, required: true, placeholder: "e.g. +1 214 555 0133", helpText: "A number we can reach you on." },
          { pageId: "page-2", label: "Reason for Visit", type: "long_text" as const, required: true, placeholder: "Briefly describe your symptoms or reason...", helpText: "Helps your provider prepare." },
          { pageId: "page-2", label: "Insurance Provider", type: "short_text" as const, required: false, placeholder: "e.g. BlueCross", helpText: "Optional." },
          { pageId: "page-2", label: "Emergency Contact", type: "short_text" as const, required: true, placeholder: "e.g. Grace Okoro, +1 214 555 0199", helpText: "Name and phone number." },
        ],
        settings: { layout: "steps", successMessage: "Thank you — your intake is complete. We'll see you at your appointment." },
        branding: { primaryColor: "#0891b2", fontFamily: "inter", panelTreatment: "solid", backgroundStyle: "wash", cardStyle: "bordered", buttonStyle: "solid", buttonRadius: "8px", formWidth: "standard", spacing: "comfortable" },
      },
      {
        name: "Appointment Request",
        category: "Medicine",
        description: "Let a patient request a preferred date, time and department for a visit.",
        theme: "appointment-request",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Request an appointment", description: "We'll confirm a time that works." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Chloe Dubois", helpText: "Your legal full name." },
          { pageId: "page-1", label: "Phone", type: "phone" as const, required: true, placeholder: "e.g. +1 206 555 0147", helpText: "A number we can reach you on." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. chloe@example.com", helpText: "We'll send your confirmation here." },
          { pageId: "page-1", label: "Department", type: "dropdown" as const, required: true, options: ["General Medicine", "Pediatrics", "Dermatology", "Dental"], placeholder: "Select department...", helpText: "Which department you'd like to see." },
          { pageId: "page-1", label: "Preferred Date", type: "date" as const, required: true, placeholder: "Select a date...", helpText: "We'll do our best to accommodate." },
          { pageId: "page-1", label: "Preferred Time", type: "time" as const, required: true, placeholder: "Select a time...", helpText: "Your ideal appointment time." },
          { pageId: "page-1", label: "Reason for Visit", type: "long_text" as const, required: false, placeholder: "Briefly describe why you're visiting...", helpText: "Optional, but helpful." },
        ],
        settings: { layout: "classic", successMessage: "Request received — our front desk will confirm your appointment." },
        branding: { primaryColor: "#0891b2", fontFamily: "inter", panelTreatment: "solid", backgroundStyle: "plain", cardStyle: "soft", buttonStyle: "solid", buttonRadius: "8px", formWidth: "standard", spacing: "comfortable" },
      },
      {
        name: "Telehealth Consultation",
        category: "Medicine",
        description: "Collect symptoms and medications before a remote video consultation.",
        theme: "telehealth-consultation",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Before your call", description: "A few details for your provider." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Aisha Rahman", helpText: "Your legal full name." },
          { pageId: "page-1", label: "Date of Birth", type: "date" as const, required: true, placeholder: "Select a date...", helpText: "For your patient record." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. aisha@example.com", helpText: "We'll send your video link here." },
          { pageId: "page-1", label: "Phone", type: "phone" as const, required: true, placeholder: "e.g. +1 917 555 0122", helpText: "A backup number, in case of connection issues." },
          { pageId: "page-1", label: "Symptoms", type: "long_text" as const, required: true, placeholder: "Describe what you're experiencing...", helpText: "The more detail, the better prepared your provider will be." },
          { pageId: "page-1", label: "Current Medications", type: "long_text" as const, required: false, placeholder: "List any medications you're taking...", helpText: "Optional." },
          { pageId: "page-1", label: "Preferred Consultation Time", type: "datetime" as const, required: true, placeholder: "Select date and time...", helpText: "When you'd like the call to happen." },
        ],
        settings: { layout: "guided", successMessage: "You're all set — your video link will arrive by email shortly." },
        branding: { primaryColor: "#0891b2", fontFamily: "inter", panelTreatment: "pattern", backgroundStyle: "dots", cardStyle: "flat", buttonStyle: "outline", buttonRadius: "4px", formWidth: "standard", spacing: "comfortable" },
      },

      // ─── Personal (fuchsia, Fredoka) ─────────────────────────────────────────
      {
        name: "Party RSVP",
        category: "Personal",
        description: "A cheerful RSVP for a birthday, housewarming or any personal get-together.",
        theme: "party-rsvp",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Can you make it?", description: "Let us know by the end of the week!" },
        ],
        fields: [
          { pageId: "page-1", label: "Your Name", type: "short_text" as const, required: true, placeholder: "e.g. Leo Martin", helpText: "So we know who's coming." },
          { pageId: "page-1", label: "Will You Attend?", type: "yes_no" as const, required: true, placeholder: "Select an answer...", helpText: "No worries if you can't make it." },
          { pageId: "page-1", label: "Number of Guests", type: "number" as const, required: false, min: 1, max: 6, placeholder: "e.g. 2", helpText: "Including yourself." },
          { pageId: "page-1", label: "Bringing a Dish?", type: "short_text" as const, required: false, placeholder: "e.g. my famous guacamole", helpText: "Optional — totally not required!" },
        ],
        settings: { layout: "card_stack", successMessage: "Got it — can't wait to see you there!" },
        branding: { primaryColor: "#9333ea", fontFamily: "fredoka", panelTreatment: "gradient", backgroundStyle: "gradient", cardStyle: "elevated", buttonStyle: "solid", buttonRadius: "16px", formWidth: "narrow", spacing: "comfortable" },
      },
      {
        name: "Roommate Application",
        category: "Personal",
        description: "A friendly questionnaire for someone applying to share your home.",
        theme: "roommate-application",
        isActive: true,
        pages: [
          { id: "page-1", order: 0, title: "Tell us about yourself", description: "So we can see if it's a good fit." },
        ],
        fields: [
          { pageId: "page-1", label: "Full Name", type: "short_text" as const, required: true, placeholder: "e.g. Sam Patel", helpText: "Your first and last name." },
          { pageId: "page-1", label: "Email", type: "email" as const, required: true, placeholder: "e.g. sam@example.com", helpText: "We'll get back to you here." },
          { pageId: "page-1", label: "Phone", type: "phone" as const, required: false, placeholder: "e.g. +1 408 555 0155", helpText: "Optional." },
          { pageId: "page-1", label: "Occupation", type: "short_text" as const, required: false, placeholder: "e.g. Graphic Designer", helpText: "What you do for work or study." },
          { pageId: "page-1", label: "Preferred Move-in Date", type: "date" as const, required: true, placeholder: "Select a date...", helpText: "When you'd ideally like to move in." },
          { pageId: "page-1", label: "Do You Have Pets?", type: "yes_no" as const, required: true, placeholder: "Select an answer...", helpText: "Just so we know up front." },
          { pageId: "page-1", label: "Tell Us About Yourself", type: "long_text" as const, required: true, placeholder: "Lifestyle, habits, what you're looking for...", helpText: "A few sentences is great." },
        ],
        settings: { layout: "guided", successMessage: "Thanks! We'll review your application and reach out soon." },
        branding: { primaryColor: "#9333ea", fontFamily: "fredoka", panelTreatment: "solid", backgroundStyle: "wash", cardStyle: "soft", buttonStyle: "solid", buttonRadius: "8px", formWidth: "standard", spacing: "comfortable" },
      },

      {
        name: "Master Comprehensive Template",
        category: "General",
        theme: "classic-light",
        isActive: true,
        showInGallery: false, // internal test content: not shown to guests
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
