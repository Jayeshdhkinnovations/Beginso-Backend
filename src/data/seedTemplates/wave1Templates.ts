// Wave 1: 25 templates. Notes (show-if intent, yes/no labels, tags) are at the top of builders.ts.

import {
  text,
  longText,
  email,
  phone,
  num,
  date,
  time,
  dateTime,
  choice,
  multi,
  rating,
  yesNo,
  url,
  address,
  currency,
  signature,
  photo,
  pdf,
  R,
  tpl,
  LEADS,
  ORDERS,
  EVENTS,
  BOOKINGS,
  FEEDBACK,
  HR,
  EDU,
  REAL,
  COMMUNITY,
  INTERNAL,
  CONSENT,
} from "./builders";

export const wave1Templates = [
  // ───────── Leads & Contact ─────────
  tpl({
    name: "Contact Us", slug: "contact-us", category: LEADS, tags: ["contact", "simple"],
    description: "A short contact form that sends you a name, an email, a topic and a message.",
    look: "minimal_paper", featured: true,
    steps: [{
      title: "Say hello", description: "We usually reply within one working day.",
      fields: [
        text("Name", R), email("Email", R),
        choice("Topic", ["Question", "Support", "Partnership", "Other"], R),
        longText("Message", { required: true, ph: "How can we help?" }),
      ],
    }],
    submit: "Send message", headline: "Message sent",
    message: "Thanks for writing. We'll reply by email.",
  }),
  tpl({
    name: "Demo Request", slug: "demo-request", category: LEADS, tags: ["sales", "b2b", "lead"],
    description: "Let a visitor ask for a demo and tell you about their team.",
    look: "clean_corporate", layout: "classic",
    steps: [{
      title: "Book a demo", description: "Tell us a little and we'll set up a time.",
      fields: [
        text("Full name", R), email("Work email", R), text("Company", R),
        choice("Team size", ["1–10", "11–50", "51–200", "200+"], R),
        longText("What would you like to see?", { ph: "Optional" }),
        phone("Phone", { help: "Only if you'd rather we call." }),
      ],
    }],
    submit: "Request demo", headline: "Request received",
    message: "Thanks. We'll reply within one working day to set a time.",
  }),
  tpl({
    name: "Quote Request", slug: "quote-request", category: LEADS, tags: ["services", "lead"],
    description: "Collect the details you need to give a price for a job.",
    look: "clean_corporate", layout: "steps",
    steps: [
      { title: "About you", fields: [text("Name", R), email("Email", R), phone("Phone")] },
      {
        title: "The job", description: "The more detail, the better the quote.",
        fields: [
          choice("What do you need?", ["New project", "Repair", "Maintenance", "Not sure"], R),
          longText("Describe the job", R),
          currency("Budget", { help: "Optional. A rough figure is fine." }),
          date("Ideal start date"), photo("Photos"),
        ],
      },
    ],
    submit: "Get my quote", next: "Next", back: "Back", headline: "Thank you",
    message: "We have your request and will send a quote by email.",
  }),
  tpl({
    name: "Free Trial Request", slug: "free-trial-request", category: LEADS, tags: ["saas", "lead"],
    description: "Capture a qualified lead before they start a free trial.",
    look: "clean_corporate", layout: "split_feature", banner: "No credit card required",
    steps: [{
      title: "Start your free trial", description: "Four quick questions.",
      fields: [
        text("Full name", R), email("Work email", R), text("Company", R),
        choice("Team size", ["1–10", "11–50", "51–200", "200+"], R),
      ],
    }],
    submit: "Start my trial", headline: "Your trial is on its way",
    message: "Check your inbox for setup instructions.",
  }),
  tpl({
    name: "Newsletter Signup", slug: "newsletter-signup", category: LEADS, tags: ["email", "marketing"],
    description: "A short signup for a newsletter or mailing list.",
    look: "minimal_paper",
    steps: [{
      title: "Stay in the loop", description: "News and the occasional offer. Unsubscribe any time.",
      fields: [
        email("Email", R), text("First name"),
        multi("What are you interested in?", ["Product updates", "Tips", "Events", "Offers"]),
      ],
    }],
    submit: "Subscribe", headline: "You're subscribed",
    message: "Look out for the next issue in your inbox.",
  }),
  tpl({
    name: "Waitlist", slug: "waitlist", category: LEADS, tags: ["launch", "saas", "restock"],
    description: "Collect emails for a launch, a restock or an early-access list.",
    look: "dark_tech", featured: true,
    steps: [{
      title: "Be first in line", description: "We'll email you the moment it's ready.",
      fields: [
        email("Email", R),
        choice("What would you use it for?", ["Work", "Personal", "Just curious"]),
        choice("How did you hear about us?", ["Search", "Social media", "A friend", "Other"]),
      ],
    }],
    submit: "Join the waitlist", headline: "You're on the list",
    message: "We'll be in touch as soon as there's news.",
  }),

  // ───────── Orders & Payments ─────────
  tpl({
    name: "Product Order", slug: "product-order", category: ORDERS, tags: ["order", "shop"],
    description: "Take an order for a small catalogue, with delivery details. Payment is arranged afterwards.",
    look: "warm_friendly", layout: "steps", brand: "#B5421A",
    steps: [
      {
        title: "Your order", description: "Pick an item and how many.",
        fields: [
          choice("Product", ["Item one", "Item two", "Item three", "Item four"], R),
          num("Quantity", { required: true, min: 1, max: 20 }),
        ],
      },
      {
        title: "Delivery", description: "Where should it go?",
        fields: [
          text("Full name", R), address("Delivery address", R), phone("Phone", R),
          longText("Notes for delivery", { help: "Gate code, delivery window, anything the courier should know." }),
        ],
      },
    ],
    submit: "Place order", next: "Next", back: "Back", headline: "Order received",
    message: "We'll confirm your order by email and tell you how to pay.",
  }),
  tpl({
    name: "Donation Pledge", slug: "donation-pledge", category: ORDERS, tags: ["nonprofit", "donation"],
    description: "Let supporters pledge an amount. You send payment details afterwards.",
    look: "warm_friendly", layout: "open", brand: "#2F6B4F",
    steps: [{
      title: "Support our work",
      description: "Tell us how much you'd like to give and we'll email you how to complete your gift.",
      fields: [
        currency("Amount", { required: true, min: 1 }),
        choice("How often?", ["Just once", "Every month"], R),
        text("Full name", R), email("Email", R),
        text("In honour or memory of", { help: "Optional dedication." }),
      ],
    }],
    submit: "Send my pledge", headline: "Thank you",
    message: "We'll email you shortly with how to complete your gift.",
  }),

  // ───────── Events & RSVPs ─────────
  tpl({
    name: "Event Registration", slug: "event-registration", category: EVENTS, tags: ["event", "registration"],
    description: "Register attendees for a conference or ticketed event, with dietary needs.",
    look: "bold_event", banner: "Limited seats", featured: true,
    steps: [{
      title: "Save your seat", description: "Takes about a minute.",
      fields: [
        text("Full name", { required: true, help: "As you'd like it on your badge." }),
        email("Email", { required: true, help: "Your ticket is sent here." }),
        choice("Ticket", ["General", "VIP", "Student"], R),
        num("Guests", { min: 0, max: 5, help: "Not counting yourself." }),
        multi("Dietary needs", ["Vegetarian", "Vegan", "Gluten-free", "Nut allergy"]),
        longText("Anything we should know?"),
      ],
    }],
    submit: "Save my seat", headline: "You're in!", confetti: true,
    message: "Your ticket is on its way by email.",
  }),
  tpl({
    name: "Wedding RSVP", slug: "wedding-rsvp", category: EVENTS, tags: ["wedding", "rsvp"],
    description: "A warm RSVP with guests, a meal choice and a song request.",
    look: "elegant_serif", featured: true, banner: "We're getting married",
    steps: [
      {
        title: "Will you join us?", description: "Please let us know if you can come.",
        fields: [
          text("Your name", R),
          yesNo("Will you attend?", R, "Joyfully accept", "Regretfully decline"),
          num("Number of guests", { min: 1, max: 4, help: "Including yourself.", showIf: { field: "Will you attend?", equals: "yes" } }),
        ],
      },
      {
        title: "Dinner and music",
        fields: [
          choice("Meal", ["Chicken", "Fish", "Vegetarian", "Vegan"], { showIf: { field: "Will you attend?", equals: "yes" } }),
          text("Dietary needs"), text("Song request", { help: "We'll try to play it." }),
          longText("A note for the couple"),
        ],
      },
    ],
    submit: "Send my reply", next: "Next", back: "Back", headline: "Thank you",
    message: "We have your reply. We'll be in touch with any updates.",
  }),
  tpl({
    name: "Party RSVP", slug: "party-rsvp", category: EVENTS, tags: ["party", "rsvp", "personal"],
    description: "A cheerful RSVP for a birthday or get-together, with who's bringing what.",
    look: "playful_bright", featured: false,
    steps: [{
      title: "Can you make it?", description: "Let us know by the end of the week.",
      fields: [
        text("Your name", R),
        choice("Are you in?", ["Yes!", "Maybe", "Can't make it"], R),
        num("Plus-ones", { min: 0, max: 6 }),
        choice("What are you bringing?", ["Snacks", "Drinks", "Dessert", "Just me"]),
        text("Allergies"),
      ],
    }],
    submit: "Count me in", headline: "Yay!", confetti: true,
    message: "Got it. See you there.",
  }),
  tpl({
    name: "Workshop Sign-up", slug: "workshop-sign-up", category: EVENTS, tags: ["workshop", "class", "registration"],
    description: "Take sign-ups for a workshop, with the level and what people hope to learn.",
    look: "warm_friendly", layout: "classic", brand: "#2F6B4F",
    steps: [{
      title: "Reserve your place", description: "Spaces are limited.",
      fields: [
        text("Full name", R), email("Email", R),
        choice("Experience level", ["Beginner", "Some experience", "Advanced"], R),
        longText("What do you hope to learn?"),
      ],
    }],
    submit: "Reserve my place", headline: "You're signed up",
    message: "We'll email you the details before the workshop.",
  }),

  // ───────── Bookings ─────────
  tpl({
    name: "Appointment Booking", slug: "appointment-booking", category: BOOKINGS, tags: ["appointment", "healthcare", "services"],
    description: "Let a client request a service at a preferred date and time.",
    look: "calm_care", layout: "steps", featured: true,
    steps: [
      {
        title: "What and when", description: "Pick a service and a time that suits you.",
        fields: [
          choice("Service", ["Consultation", "Follow-up", "First visit", "Other"], R),
          date("Preferred date", R), time("Preferred time", R),
        ],
      },
      {
        title: "About you",
        fields: [
          text("Full name", R), phone("Phone", R), email("Email", R),
          longText("Anything we should know?"),
        ],
      },
    ],
    submit: "Request appointment", next: "Next", back: "Back", headline: "Request received",
    message: "We'll confirm your appointment by email.",
  }),
  tpl({
    name: "Table Reservation", slug: "table-reservation", category: BOOKINGS, tags: ["restaurant", "reservation"],
    description: "Take table requests with party size, date, time and the occasion.",
    look: "appetite", brand: "#B3261E",
    steps: [{
      title: "Reserve a table", description: "We look forward to having you.",
      fields: [
        text("Name", R), phone("Phone", R),
        choice("Party size", ["1", "2", "3", "4", "5", "6 or more"], R),
        date("Date", R), time("Time", R),
        choice("Occasion", ["Birthday", "Anniversary", "Business", "Just dinner"]),
        longText("Special requests", { help: "Allergies, seating, anything else." }),
      ],
    }],
    submit: "Reserve my table", headline: "Table requested",
    message: "We'll confirm your booking shortly.",
  }),

  // ───────── Feedback & Surveys ─────────
  tpl({
    name: "Quick Rating", slug: "quick-rating", category: FEEDBACK, tags: ["feedback", "rating", "csat"],
    description: "One star rating, one reason, and an optional email.",
    look: "minimal_paper", layout: "focus",
    steps: [{
      title: "How are we doing?",
      fields: [
        rating("How would you rate us?", R),
        longText("What's the main reason?"),
        email("Email", { help: "Only if you'd like a reply." }),
      ],
    }],
    submit: "Send feedback", headline: "Thank you", message: "That really helps.",
  }),
  tpl({
    name: "Event Feedback", slug: "event-feedback", category: FEEDBACK, tags: ["event", "feedback"],
    description: "Ask attendees what worked, what didn't and whether they'd come again.",
    look: "warm_friendly", layout: "guided",
    steps: [{
      title: "How was the event?", description: "Two minutes, and it shapes the next one.",
      fields: [
        rating("Overall", R),
        longText("What worked well?"), longText("What should we change?"),
        yesNo("Would you come again?", R),
        email("Email", { help: "Only if you'd like a reply." }),
      ],
    }],
    submit: "Send feedback", headline: "Thank you", message: "We read every response.",
  }),

  // ───────── HR & Hiring ─────────
  tpl({
    name: "Job Application", slug: "job-application", category: HR, tags: ["hiring", "application"],
    description: "Collect a candidate's details, CV and a short note for an open role.",
    look: "clean_corporate", layout: "steps", featured: true,
    steps: [
      {
        title: "About you", description: "How can we reach you?",
        fields: [text("Full name", R), email("Email", R), phone("Phone", R), text("City")],
      },
      {
        title: "Your work",
        fields: [
          text("Role you're applying for", R), pdf("CV", { required: true, help: "PDF, up to 10 MB." }),
          url("Portfolio or LinkedIn"),
          choice("Experience", ["0–1 years", "2–4 years", "5–9 years", "10+ years"], R),
        ],
      },
      {
        title: "One last thing",
        fields: [longText("Why this role?"), date("Earliest start date")],
      },
    ],
    submit: "Send application", next: "Next", back: "Back", headline: "Application received",
    message: "Thank you for applying. We read every application and will be in touch.",
  }),
  tpl({
    name: "Time-off Request", slug: "time-off-request", category: HR, tags: ["leave", "internal", "hr"],
    description: "Let staff request leave, with dates and their manager's email.",
    look: "clean_corporate", layout: "classic",
    steps: [{
      title: "Request time off",
      fields: [
        text("Your name", R),
        choice("Type of leave", ["Annual leave", "Sick leave", "Unpaid leave", "Other"], R),
        date("First day off", R), date("Last day off", R),
        longText("Reason", { help: "Optional." }),
        email("Manager's email", { required: true, help: "We'll send the request here for approval." }),
      ],
    }],
    submit: "Send request", headline: "Request sent",
    message: "Your manager will review it and reply by email.",
  }),

  // ───────── Education ─────────
  tpl({
    name: "Course Enrollment", slug: "course-enrollment", category: EDU, tags: ["course", "enrollment"],
    description: "Enrol a student in a course, with their level and how they found you.",
    look: "warm_friendly", layout: "split_feature", brand: "#1F6F6B",
    steps: [{
      title: "Enrol now", description: "Reserve your place in the course.",
      fields: [
        text("Full name", R), email("Email", R), text("Course", R),
        choice("Your level of study", ["High school", "Undergraduate", "Graduate", "Other"]),
        choice("How did you hear about us?", ["Social media", "A friend", "Search", "Other"]),
        phone("Phone"),
      ],
    }],
    submit: "Enrol me", headline: "You're enrolled",
    message: "Course details are on their way to your inbox.",
  }),

  // ───────── Real Estate ─────────
  tpl({
    name: "Maintenance Request", slug: "maintenance-request", category: REAL, tags: ["tenant", "repair", "property"],
    description: "Let tenants report a problem, with a photo and how urgent it is.",
    look: "calm_care", layout: "steps", brand: "#1D6A5C",
    steps: [
      {
        title: "About you",
        description: "For emergencies such as a gas leak or fire, call your local emergency number instead.",
        fields: [text("Your name", R), text("Unit or address", R), phone("Phone", R)],
      },
      {
        title: "The problem",
        fields: [
          choice("What's the problem?", ["Plumbing", "Electrical", "Heating or cooling", "Appliance", "Other"], R),
          longText("Describe it", R), photo("Photos"),
          choice("How urgent is it?", ["Not urgent", "Soon", "Emergency"], R),
          yesNo("Can we enter if you're not home?", R),
        ],
      },
    ],
    submit: "Send request", next: "Next", back: "Back", headline: "Request received",
    message: "We'll be in touch about a visit.",
  }),

  // ───────── Community & Membership ─────────
  tpl({
    name: "Membership Signup", slug: "membership-signup", category: COMMUNITY, tags: ["membership", "club"],
    description: "Sign up a new member with an emergency contact and agreement to the terms.",
    look: "warm_friendly", layout: "steps", brand: "#2F5D8A",
    steps: [
      { title: "About you", fields: [text("Full name", R), email("Email", R), phone("Phone", R)] },
      {
        title: "Your membership",
        fields: [
          choice("Membership type", ["Individual", "Family", "Student", "Senior"], R),
          text("Emergency contact name", R), phone("Emergency contact phone", R),
          yesNo("I agree to the terms", R),
        ],
      },
    ],
    submit: "Join now", next: "Next", back: "Back", headline: "Welcome",
    message: "A confirmation email is on its way.",
  }),
  tpl({
    name: "Volunteer Sign-up", slug: "volunteer-sign-up", category: COMMUNITY, tags: ["volunteer", "nonprofit"],
    description: "Recruit volunteers and learn when and how they can help.",
    look: "warm_friendly", layout: "guided", brand: "#2F6B4F",
    steps: [{
      title: "Join us", description: "Thank you for wanting to help.",
      fields: [
        text("Full name", R), email("Email", R),
        multi("Where would you like to help?", ["Events", "Fundraising", "Mentoring", "Office help"]),
        multi("When are you free?", ["Weekdays", "Weekends", "Evenings"], R),
        longText("Any experience we should know about?"), phone("Phone"),
      ],
    }],
    submit: "Sign me up", headline: "Thank you", message: "We'll be in touch with next steps.",
  }),

  // ───────── Internal Requests & Inspections ─────────
  tpl({
    name: "IT / Bug Request", slug: "it-bug-request", category: INTERNAL, tags: ["it", "bug", "support", "internal"],
    description: "A clear ticket with category, urgency, what happened and a screenshot.",
    look: "dark_tech", layout: "compact",
    steps: [{
      title: "What's going on?",
      fields: [
        text("Title", R),
        choice("Category", ["Hardware", "Software", "Network", "Account access", "Other"], R),
        choice("Urgency", ["Low", "Normal", "High", "Urgent"], R),
        longText("What happened?", { required: true, ph: "What happened, and what did you expect?" }),
        photo("Screenshot"), email("Your email", R),
      ],
    }],
    submit: "Submit ticket", headline: "Ticket received",
    message: "We'll follow up by email.",
  }),
  tpl({
    name: "Incident Report", slug: "incident-report", category: INTERNAL, tags: ["safety", "incident", "internal"],
    description: "Record what happened, where and who was hurt, with photos.",
    look: "clean_corporate", layout: "classic", brand: "#8A3B12",
    steps: [{
      title: "Report an incident", description: "Stick to what you saw. Details matter more than neatness.",
      fields: [
        text("Your name", R), dateTime("When did it happen?", R), text("Where?", R),
        choice("Type", ["Injury", "Near miss", "Property damage", "Security", "Other"], R),
        longText("What happened?", R), yesNo("Was anyone hurt?", R), photo("Photos"),
      ],
    }],
    submit: "Submit report", headline: "Report submitted", message: "Thank you for reporting it.",
  }),

  // ───────── Consent & Legal ─────────
  tpl({
    name: "Liability Waiver", slug: "liability-waiver", category: CONSENT, tags: ["waiver", "consent", "signature"],
    description: "Collect a signed waiver, with a guardian signature for under-18s.",
    look: "calm_care", layout: "steps",
    steps: [
      {
        title: "Who is taking part?",
        description: "Sample template. Have a professional check the wording and rules for your country before using it.",
        fields: [
          text("Participant name", R), date("Date of birth", R), text("Activity", R),
          yesNo("Is the participant under 18?", R),
        ],
      },
      {
        title: "Waiver and signature",
        description: "Replace this paragraph with your own waiver wording.",
        fields: [
          yesNo("I have read and accept the waiver", R),
          signature("Participant signature", R),
          text("Guardian name", { required: true, showIf: { field: "Is the participant under 18?", equals: "yes" } }),
          signature("Guardian signature", { required: true, showIf: { field: "Is the participant under 18?", equals: "yes" } }),
        ],
      },
    ],
    submit: "Sign and submit", next: "Next", back: "Back", headline: "Waiver signed",
    message: "A record of your signed waiver has been saved.",
  }),
];
