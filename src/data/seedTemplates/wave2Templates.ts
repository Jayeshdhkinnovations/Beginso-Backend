// Wave 2: the current templates rebuilt to the recipe (30). Notes are at the top of builders.ts.

import {
  text, longText, email, phone, num, date, time, dateTime, choice, multi, rating, yesNo, url,
  address, currency, signature, photo, pdf, fileUpload, R, tpl, SAMPLE,
  LEADS, ORDERS, EVENTS, BOOKINGS, FEEDBACK, HR, EDU, REAL, COMMUNITY, INTERNAL, CONSENT, HEALTH,
} from "./builders";

export const wave2Templates = [
  // ───────── Leads & Contact ─────────
  tpl({
    name: "Partnership Inquiry", slug: "partnership-inquiry", category: LEADS, tags: ["b2b", "partnership"],
    description: "Collect a proposed partnership's details and timeline before a first call.",
    look: "clean_corporate", layout: "classic",
    steps: [
      {
        title: "About your company",
        fields: [text("Full name", R), email("Work email", R), text("Company", R), url("Company website")],
      },
      {
        title: "The proposal", description: "What do you have in mind?",
        fields: [
          choice("Type of partnership", ["Reseller", "Technology integration", "Co-marketing", "Other"], R),
          longText("What would you like to do together?", R),
          choice("Timeline", ["Right away", "This quarter", "Next quarter", "Just exploring"]),
          phone("Phone"),
        ],
      },
    ],
    submit: "Send proposal", headline: "Thank you", message: "We'll review it and be in touch.",
  }),
  tpl({
    name: "Support Request", slug: "support-request", category: LEADS, tags: ["support", "customer"],
    description: "A clear support ticket with priority and a screenshot.",
    look: "clean_corporate", layout: "steps",
    steps: [
      { title: "About you", fields: [text("Name", R), email("Email", R), text("Account or order ID")] },
      {
        title: "What's going on?", description: "The more detail, the faster we can help.",
        fields: [
          choice("Issue type", ["Billing", "Bug", "Feature request", "Account access", "Other"], R),
          choice("Priority", ["Low", "Normal", "High", "Urgent"], R),
          longText("Describe the issue", { required: true, ph: "What happened, and what did you expect?" }),
          photo("Screenshot"),
        ],
      },
    ],
    submit: "Send ticket", next: "Next", back: "Back", headline: "Ticket received",
    message: "Our support team will follow up by email.",
  }),

  // ───────── Orders & Payments ─────────
  tpl({
    name: "Food Delivery Order", slug: "food-delivery-order", category: ORDERS, tags: ["food", "order", "delivery"],
    description: "Take a food order with delivery details. Payment is on delivery or already made.",
    look: "appetite", layout: "chat",
    steps: [{
      title: "Your order", description: "What would you like?",
      fields: [
        text("Name", R), phone("Phone", { required: true, help: "In case the courier needs to reach you." }),
        choice("Main item", ["Margherita Pizza", "Butter Chicken", "Veggie Burrito Bowl", "Pad Thai"], R),
        num("How many?", { required: true, min: 1, max: 10 }),
        choice("Spice level", ["Mild", "Medium", "Hot"]),
        address("Delivery address", R),
        choice("When?", ["As soon as possible", "Schedule for later"], R),
        time("Delivery time", { help: "Only if you chose later.", showIf: { field: "When?", equals: "Schedule for later" } }),
        choice("How will you pay?", ["Cash on delivery", "Card on delivery", "Already paid online"], R),
        longText("Special instructions", { help: "Allergies, gate code, anything else." }),
      ],
    }],
    submit: "Place order", headline: "Order received", message: "Your food is being prepared.",
  }),
  tpl({
    name: "Service Order Request", slug: "service-order-request", category: ORDERS, tags: ["business", "order", "recurring"],
    description: "Let a business customer order a recurring service with a purchase order number.",
    look: "clean_corporate", layout: "classic",
    steps: [
      {
        title: "Your details",
        fields: [text("Full name", R), text("Company"), email("Email", R), phone("Phone")],
      },
      {
        title: "Order details", description: "What, how much and when.",
        fields: [
          choice("Service", ["Cleaning", "Landscaping", "IT support", "Maintenance", "Other"], R),
          num("Units or visits", { required: true, min: 1 }),
          date("Preferred start date", R), address("Billing address", R),
          text("Purchase order number", { help: "Only if your company needs one." }),
          longText("Notes"),
        ],
      },
    ],
    submit: "Send order", headline: "Order received", message: "We'll confirm scheduling by email.",
  }),
  tpl({
    name: "Return & Exchange Request", slug: "return-exchange-request", category: ORDERS, tags: ["shop", "returns"],
    description: "Let a customer start a return or exchange, with a photo of the item.",
    look: "warm_friendly", layout: "steps",
    steps: [
      {
        title: "Your order", description: "Find your order first.",
        fields: [
          text("Order number", { required: true, help: "In your confirmation email." }),
          email("Email used for the order", R),
        ],
      },
      {
        title: "What happened?",
        fields: [
          choice("What would you like?", ["Refund", "Exchange"], R),
          choice("Reason", ["Wrong size", "Damaged", "Not as described", "Changed my mind", "Other"], R),
          choice("Condition of the item", ["Unopened", "Opened, unused", "Used"], R),
          photo("Photo of the item", { help: "Helpful for damaged items." }),
        ],
      },
    ],
    submit: "Send request", next: "Next", back: "Back", headline: "Request received",
    message: "We'll email you the next steps.",
  }),

  // ───────── Events & RSVPs ─────────
  tpl({
    name: "Webinar Signup", slug: "webinar-signup", category: EVENTS, tags: ["webinar", "online", "registration"],
    description: "A fast signup for a free webinar or online event.",
    look: "bold_event", layout: "focus", banner: "Spots are limited",
    steps: [{
      title: "Save your spot",
      fields: [
        text("Full name", R), email("Work email", { required: true, help: "The join link is sent here." }),
        text("Job title"),
        choice("How did you hear about it?", ["Social media", "Email", "A colleague", "Search", "Other"]),
      ],
    }],
    submit: "Save my spot", headline: "You're registered", message: "We'll email the join link before the event.",
  }),
  tpl({
    name: "Fundraising Event Registration", slug: "fundraising-event-registration", category: EVENTS, tags: ["fundraiser", "charity", "event"],
    description: "Register attendees and sponsors for a gala or charity run.",
    look: "warm_friendly", layout: "split_feature", brand: "#2F6B4F",
    steps: [{
      title: "Join the cause", description: "Register for the event.",
      fields: [
        text("Full name", R), email("Email", R),
        num("Number of tickets", { required: true, min: 1, max: 10 }),
        choice("Sponsorship level", ["None", "Bronze", "Silver", "Gold", "Platinum"]),
        multi("Dietary needs", ["Vegetarian", "Vegan", "Gluten-free"]), phone("Phone"),
      ],
    }],
    submit: "Register", headline: "You're registered", message: "Thank you for supporting the cause.",
  }),

  // ───────── Bookings ─────────
  tpl({
    name: "Venue / Room Booking", slug: "venue-room-booking", category: BOOKINGS, tags: ["venue", "room", "booking"],
    description: "Request a meeting room or event space for a date and time window.",
    look: "clean_corporate", layout: "sidebar",
    steps: [
      { title: "About you", fields: [text("Full name", R), email("Email", R), text("Organisation")] },
      { title: "Date and time", fields: [date("Event date", R), time("Start time", R), time("End time", R)] },
      {
        title: "The space",
        fields: [
          choice("Room", ["Small meeting room", "Large meeting room", "Event hall"], R),
          num("Expected attendees", { min: 1, max: 500 }), longText("Anything else?"),
        ],
      },
    ],
    submit: "Request booking", next: "Next", back: "Back", headline: "Request received",
    message: "We'll confirm availability shortly.",
  }),
  tpl({
    name: "Schedule a Viewing", slug: "schedule-a-viewing", category: BOOKINGS, tags: ["real-estate", "viewing", "booking"],
    description: "Let a buyer or renter book a time to see a property.",
    look: "editorial", layout: "classic",
    steps: [{
      title: "Book a viewing", description: "Pick a day and time that works for you.",
      fields: [
        text("Full name", R), email("Email", R), phone("Phone", R),
        text("Property", { required: true, help: "Address or listing number." }),
        date("Preferred date", R), time("Preferred time", R),
      ],
    }],
    submit: "Request viewing", headline: "Viewing requested", message: "Your agent will confirm the time shortly.",
  }),

  // ───────── Feedback & Surveys ─────────
  tpl({
    name: "Customer Satisfaction Survey", slug: "customer-satisfaction-survey", category: FEEDBACK, tags: ["csat", "survey", "customer"],
    description: "A short survey after a purchase: a rating and open feedback.",
    look: "minimal_paper", layout: "guided",
    steps: [{
      title: "How did we do?",
      fields: [
        rating("Overall satisfaction", R), longText("What did you like most?"),
        longText("What could we improve?"), yesNo("Would you recommend us?", R),
        email("Email", { help: "Only if you'd like a reply." }),
      ],
    }],
    submit: "Send feedback", headline: "Thank you", message: "We read every response.",
  }),
  tpl({
    name: "Website Feedback", slug: "website-feedback", category: FEEDBACK, tags: ["website", "feedback"],
    description: "A light form for visitors to flag problems or suggest improvements.",
    look: "minimal_paper", layout: "open",
    steps: [{
      title: "How was your visit?",
      fields: [
        rating("Overall", R), yesNo("Was it easy to find what you needed?", R),
        longText("What should we fix or add?"), email("Email", { help: "Only if you'd like a reply." }),
      ],
    }],
    submit: "Send feedback", headline: "Thank you", message: "We'll put it to good use.",
  }),

  // ───────── HR & Hiring ─────────
  tpl({
    name: "Employee Onboarding", slug: "employee-onboarding", category: HR, tags: ["onboarding", "new-hire"],
    description: "Collect what a new hire needs to confirm before their first day.",
    look: "warm_friendly", layout: "card_stack", brand: "#2F5D8A",
    steps: [
      { title: "Welcome aboard", fields: [text("Full name", R), email("Personal email", R), date("First day", R)] },
      { title: "Emergency contact", fields: [text("Contact name", R), phone("Contact phone", R)] },
      {
        title: "Welcome kit",
        fields: [{ ...choice("T-shirt size", ["XS", "S", "M", "L", "XL", "XXL"]), type: "dropdown" as const }],
      },
    ],
    submit: "Send details", headline: "Welcome", message: "Your details are on file. See you on your first day.",
  }),
  tpl({
    name: "Exit Interview", slug: "exit-interview", category: HR, tags: ["exit", "hr", "feedback"],
    description: "A structured conversation starter for people who are leaving.",
    look: "clean_corporate", layout: "guided",
    steps: [{
      title: "Before you go", description: "Your feedback helps us improve.",
      fields: [
        text("Full name", R), text("Team", R), date("Last working day", R),
        choice("Main reason for leaving", ["New opportunity", "Pay", "Work-life balance", "Relocation", "Other"], R),
        longText("What could we have done better?", { help: "This goes to HR." }),
      ],
    }],
    submit: "Send", headline: "Thank you", message: "Thank you for your honesty, and for your time with us.",
  }),

  // ───────── Education ─────────
  tpl({
    name: "Scholarship Application", slug: "scholarship-application", category: EDU, tags: ["scholarship", "application"],
    description: "Collect an applicant's details, essay and transcript.",
    look: "editorial", layout: "steps",
    steps: [
      {
        title: "About you",
        fields: [text("Full name", R), email("Email", R), text("School or university", R), text("Grade or GPA")],
      },
      {
        title: "Your application",
        fields: [
          longText("Why should you receive this scholarship?", R),
          pdf("Transcript", { required: true, help: "PDF, up to 10 MB." }),
        ],
      },
    ],
    submit: "Submit application", next: "Next", back: "Back", headline: "Application submitted",
    message: "Thank you. Good luck.",
  }),
  tpl({
    name: "Student Feedback Survey", slug: "student-feedback-survey", category: EDU, tags: ["course", "feedback"],
    description: "Gather end-of-course feedback on the teacher and the material.",
    look: "warm_friendly", layout: "focus",
    steps: [{
      title: "How was the course?",
      fields: [
        text("Course name", R), rating("Teacher", R),
        longText("What worked well?"), longText("What would you change?"),
      ],
    }],
    submit: "Send feedback", headline: "Thank you", message: "Your feedback shapes the next course.",
  }),

  // ───────── Healthcare ─────────
  tpl({
    name: "Patient Intake", slug: "patient-intake", category: HEALTH, tags: ["clinic", "intake", "healthcare"],
    description: "Collect a new patient's details, reason for visit and insurance.",
    look: "calm_care", layout: "steps",
    steps: [
      {
        title: "About you", description: SAMPLE,
        fields: [text("Full name", R), date("Date of birth", R), email("Email", R), phone("Phone", R)],
      },
      {
        title: "Your visit",
        fields: [
          longText("Reason for your visit", R), text("Insurance provider"),
          text("Emergency contact name", R), phone("Emergency contact phone", R),
        ],
      },
    ],
    submit: "Send intake form", next: "Next", back: "Back", headline: "Thank you",
    message: "Your details are with us. We'll see you at your appointment.",
  }),
  tpl({
    name: "Telehealth Consultation", slug: "telehealth-consultation", category: HEALTH, tags: ["telehealth", "video", "healthcare"],
    description: "Collect symptoms and medications before a video consultation.",
    look: "calm_care", layout: "card_stack",
    steps: [
      {
        title: "About you", description: SAMPLE,
        fields: [
          text("Full name", R), date("Date of birth", R), email("Email", { required: true, help: "The video link is sent here." }),
          phone("Backup phone", { required: true, help: "In case the connection drops." }),
        ],
      },
      {
        title: "Your health",
        fields: [longText("Symptoms", R), longText("Current medications")],
      },
      { title: "The call", fields: [dateTime("Preferred time", R)] },
    ],
    submit: "Request consultation", headline: "You're all set", message: "Your video link will arrive by email.",
  }),

  // ───────── Real Estate ─────────
  tpl({
    name: "Property Inquiry", slug: "property-inquiry", category: REAL, tags: ["property", "buyer", "renter"],
    description: "Let a buyer or renter ask about a listing.",
    look: "editorial", layout: "classic",
    steps: [{
      title: "Interested in this property?", description: "Send your question and we'll follow up.",
      fields: [
        text("Full name", R), email("Email", R), phone("Phone"),
        text("Property", { required: true, help: "Address or listing number." }),
        choice("How should we reach you?", ["Email", "Phone call", "Text message"]),
        longText("Your message", R),
      ],
    }],
    submit: "Send question", headline: "Thank you", message: "An agent will be in touch shortly.",
  }),
  tpl({
    name: "Rental Application", slug: "rental-application", category: REAL, tags: ["rental", "tenant", "application"],
    description: "Collect a tenant's income, move-in date and proof of income.",
    look: "clean_corporate", layout: "sidebar",
    steps: [
      { title: "About you", fields: [text("Full name", R), email("Email", R), phone("Phone", R)] },
      { title: "Where you live", fields: [address("Current address", R)] },
      {
        title: "The rental",
        fields: [
          currency("Monthly income", { required: true, min: 0, help: "Before tax." }),
          date("Move-in date", R), yesNo("Do you have pets?", R),
        ],
      },
      { title: "Documents", fields: [pdf("Proof of income", { required: true, help: "A recent pay slip or offer letter, PDF." })] },
    ],
    submit: "Send application", next: "Next", back: "Back", headline: "Application received",
    message: "We'll review it and follow up within a few days.",
  }),
  tpl({
    name: "Property Inspection Report", slug: "property-inspection-report", category: REAL, tags: ["inspection", "internal", "property"],
    description: "Record a property's condition, issues found and an estimated repair cost.",
    look: "clean_corporate", layout: "compact",
    steps: [
      {
        title: "The property",
        fields: [
          text("Inspector name", R), date("Inspection date", R), address("Property address", R),
          choice("Property type", ["House", "Apartment", "Commercial", "Land"], R),
        ],
      },
      {
        title: "Findings",
        fields: [
          choice("Overall condition", ["Excellent", "Good", "Fair", "Poor"], R),
          longText("Issues found", R), photo("Photos"), yesNo("Follow-up needed?", R),
          currency("Estimated repair cost", { min: 0 }),
        ],
      },
    ],
    submit: "Submit report", next: "Next", back: "Back", headline: "Report submitted", message: "Thank you.",
  }),
  tpl({
    name: "Roommate Application", slug: "roommate-application", category: REAL, tags: ["roommate", "housing"],
    description: "A friendly questionnaire for someone who wants to share your home.",
    look: "playful_bright", layout: "guided",
    steps: [{
      title: "Tell us about yourself", description: "So we can see if it's a good fit.",
      fields: [
        text("Full name", R), email("Email", R), text("What do you do?", { help: "Work or study." }),
        date("Ideal move-in date", R), yesNo("Do you have pets?", R),
        longText("About you", { required: true, ph: "Lifestyle, habits, what you're looking for" }), phone("Phone"),
      ],
    }],
    submit: "Send application", headline: "Thanks!", message: "We'll review your application and reach out soon.",
  }),

  // ───────── Community & Membership ─────────
  tpl({
    name: "Gym Membership Application", slug: "gym-membership-application", category: COMMUNITY, tags: ["gym", "membership", "fitness"],
    description: "Sign up a new member, with a health note and a waiver.",
    look: "bold_event", layout: "card_stack", brand: "#F0B429",
    steps: [
      {
        title: "About you",
        fields: [text("Full name", R), email("Email", R), phone("Phone", R), date("Date of birth", { required: true, help: "Members must be 16 or older." })],
      },
      { title: "Your plan", fields: [choice("Plan", ["Monthly", "Annual", "Student"], R), date("Start date", R)] },
      {
        title: "Safety",
        fields: [
          text("Emergency contact name", R), phone("Emergency contact phone", R),
          longText("Anything we should know about your health?", { help: "Injuries, conditions, medication. Kept private." }),
          yesNo("I accept the liability waiver", R),
        ],
      },
    ],
    submit: "Join the gym", headline: "Welcome", message: "Your membership starts on the date you chose.",
  }),
  tpl({
    name: "Club Membership Renewal", slug: "club-membership-renewal", category: COMMUNITY, tags: ["renewal", "club", "membership"],
    description: "A short renewal form for an existing member.",
    look: "warm_friendly", layout: "open", brand: "#2F5D8A",
    steps: [{
      title: "Renew your membership", description: "Confirm your details to carry on.",
      fields: [
        text("Full name", R), text("Member ID", R), email("Email", R),
        choice("Tier", ["Standard", "Premium", "Lifetime"], R), choice("Renew for", ["1 year", "2 years"], R),
        address("New mailing address", { help: "Only if it has changed." }), phone("Phone"), longText("Comments"),
      ],
    }],
    submit: "Renew", headline: "Renewed", message: "Your updated membership is active.",
  }),

  // ───────── Internal Requests & Inspections ─────────
  tpl({
    name: "Equipment Request", slug: "equipment-request", category: INTERNAL, tags: ["equipment", "internal", "approval"],
    description: "Request new or replacement equipment, with approval by the manager.",
    look: "clean_corporate", layout: "compact",
    steps: [{
      title: "What do you need?",
      fields: [
        text("Your name", R), text("Team", R), text("Employee ID"),
        choice("Equipment", ["Laptop", "Monitor", "Headset", "Office chair", "Other"], R),
        num("Quantity", { required: true, min: 1, max: 10 }),
        longText("Why do you need it?", R), date("Needed by"),
        email("Manager's email", { required: true, help: "The request goes here for approval." }),
      ],
    }],
    submit: "Send request", headline: "Request sent", message: "Your manager will review it.",
  }),
  tpl({
    name: "Expense Reimbursement Request", slug: "expense-reimbursement-request", category: INTERNAL, tags: ["expense", "finance", "internal"],
    description: "Submit a work expense with a receipt for approval.",
    look: "clean_corporate", layout: "steps",
    steps: [
      {
        title: "Who and what",
        fields: [
          text("Your name", R), text("Employee ID", R), date("Expense date", R),
          choice("Category", ["Travel", "Meals", "Supplies", "Software", "Other"], R),
          currency("Amount", { required: true, min: 0 }),
        ],
      },
      {
        title: "Proof and approval",
        fields: [
          choice("How did you pay?", ["Personal card", "Cash", "Company card"], R),
          longText("Why was it needed?", R),
          fileUpload("Receipt", ["image/jpeg", "image/png", "application/pdf"], { required: true, help: "Photo or PDF, up to 10 MB." }),
          email("Manager's email", { required: true, help: "Sent here for approval." }),
        ],
      },
    ],
    submit: "Submit expense", next: "Next", back: "Back", headline: "Submitted", message: "Your manager will review it.",
  }),
  tpl({
    name: "Timesheet Submission", slug: "timesheet-submission", category: INTERNAL, tags: ["timesheet", "hours", "internal"],
    description: "A weekly timesheet with hours, project and manager sign-off.",
    look: "dark_tech", layout: "compact",
    steps: [
      {
        title: "Who and when",
        fields: [text("Your name", R), text("Employee ID", R), text("Team", R), date("Week ending", R)],
      },
      {
        title: "Hours",
        fields: [
          num("Regular hours", { required: true, min: 0, max: 80 }), num("Overtime hours", { min: 0, max: 40 }),
          text("Project or client code"), longText("What did you work on?"),
          email("Manager's email", { required: true, help: "Sent here for approval." }),
        ],
      },
    ],
    submit: "Submit timesheet", next: "Next", back: "Back", headline: "Submitted", message: "Your manager will review it.",
  }),
  tpl({
    name: "Vehicle Inspection Checklist", slug: "vehicle-inspection-checklist", category: INTERNAL, tags: ["vehicle", "inspection", "checklist"],
    description: "A pre-trip or rental inspection, with photos of any damage.",
    look: "clean_corporate", layout: "steps",
    steps: [
      {
        title: "The vehicle",
        fields: [
          text("Inspector name", R), date("Date", R), text("Make and model", R),
          text("Licence plate", R), num("Mileage", { required: true, min: 0 }),
        ],
      },
      {
        title: "Condition",
        fields: [
          choice("Exterior", ["Excellent", "Good", "Fair", "Poor"], R),
          choice("Tyres", ["Excellent", "Good", "Fair", "Needs replacing"], R),
          yesNo("Brakes working?", R), yesNo("Lights working?", R),
          photo("Photos of any damage"), longText("Notes"),
        ],
      },
    ],
    submit: "Save inspection", next: "Next", back: "Back", headline: "Inspection saved", message: "Thank you.",
  }),
  tpl({
    name: "Vendor Onboarding", slug: "vendor-onboarding", category: INTERNAL, tags: ["vendor", "supplier", "procurement"],
    description: "Collect a new supplier's business details and paperwork.",
    look: "clean_corporate", layout: "steps",
    steps: [
      {
        title: "Business details",
        fields: [
          text("Company name", R), text("Contact name", R), email("Contact email", R),
          phone("Contact phone", R), address("Business address", R),
        ],
      },
      {
        title: "What you provide",
        fields: [
          text("Tax registration number", { required: true, help: "Needed for our accounting records." }),
          longText("Products or services you supply", R),
          longText("Payment terms", { help: "For example net 30. Never enter card or bank account numbers here." }),
          pdf("Registration document", { required: true, help: "PDF, up to 10 MB." }),
        ],
      },
    ],
    submit: "Send details", next: "Next", back: "Back", headline: "Thank you", message: "Our procurement team will review it.",
  }),

  // ───────── Consent & Legal ─────────
  tpl({
    name: "Photo & Video Consent", slug: "photo-video-consent", category: CONSENT, tags: ["consent", "photo", "signature"],
    description: "Get signed consent to photograph or film someone, with a choice for promotional use.",
    look: "calm_care", layout: "classic",
    steps: [
      {
        title: "About you", description: SAMPLE,
        fields: [
          text("Full name", R), email("Email", { required: true, help: "We'll send you a copy." }),
          text("Event or project", R), date("Date", R),
        ],
      },
      {
        title: "Consent and signature",
        fields: [
          yesNo("I consent to being photographed or filmed", R),
          yesNo("I consent to promotional use", { required: true, help: "Website, social media and print." }),
          yesNo("Is the person being photographed under 18?", R),
          signature("Signature", R),
          text("Parent or guardian name", { required: true, showIf: { field: "Is the person being photographed under 18?", equals: "yes" } }),
          signature("Parent or guardian signature", { required: true, showIf: { field: "Is the person being photographed under 18?", equals: "yes" } }),
        ],
      },
    ],
    submit: "Sign and submit", next: "Next", back: "Back", headline: "Consent recorded", message: "Thank you. A copy is on its way.",
  }),
  tpl({
    name: "Medical Treatment Consent", slug: "medical-treatment-consent", category: CONSENT, tags: ["consent", "healthcare", "signature"],
    description: "A signed consent to a treatment, with the risks acknowledged.",
    look: "calm_care", layout: "steps",
    steps: [
      {
        title: "Patient details", description: SAMPLE,
        fields: [
          text("Patient's full name", R), date("Date of birth", R), email("Email", { required: true, help: "We'll send a copy." }),
          longText("Allergies", { help: "Important if there are any." }),
        ],
      },
      {
        title: "The treatment",
        fields: [
          longText("Treatment or procedure", { required: true, help: "As explained by the provider." }),
          yesNo("I understand the risks", R), yesNo("I consent to the treatment", R),
          text("Emergency contact name", R), phone("Emergency contact phone", R),
          signature("Signature", R),
        ],
      },
    ],
    submit: "Sign and submit", next: "Next", back: "Back", headline: "Consent recorded", message: "Thank you. A copy is on its way.",
  }),
];
