// Wave 3: new templates (22). Notes are at the top of builders.ts.
// Not included: quizzes and personality quizzes (the builder has no quiz scoring yet).

import {
  text, longText, email, phone, num, date, time, dateTime, choice, multi, rating, yesNo, url,
  signature, photo, fileUpload, R, tpl, SAMPLE,
  LEADS, EVENTS, BOOKINGS, FEEDBACK, EDU, CONSENT, FUN,
} from "./builders";

export const wave3Templates = [
  // ───────── Leads & Contact ─────────
  tpl({
    name: "Callback Request", slug: "callback-request", category: LEADS, tags: ["phone", "lead"],
    description: "Let someone leave a number and the best time to call.",
    look: "minimal_paper", layout: "open",
    steps: [{
      title: "Call me back", description: "Leave your number and we'll ring you.",
      fields: [
        text("Name", R), phone("Phone", R),
        choice("Best time to call", ["Morning", "Afternoon", "Evening", "Any time"], R),
        text("What is it about?"),
      ],
    }],
    submit: "Request a call", headline: "Thank you", message: "We'll call you at the time you chose.",
  }),
  tpl({
    name: "Giveaway Entry", slug: "giveaway-entry", category: LEADS, tags: ["contest", "marketing", "giveaway"],
    description: "Collect entries for a giveaway or contest, with agreement to the rules.",
    look: "playful_bright", layout: "chat",
    steps: [{
      title: "Enter to win", description: "Check the rules for contests and giveaways where you live.",
      fields: [
        text("Name", R), email("Email", R), phone("Phone"),
        choice("How did you hear about it?", ["Social media", "A friend", "Our website", "Other"]),
        yesNo("I agree to the contest rules", R),
      ],
    }],
    submit: "Enter now", headline: "You're in!", confetti: true, message: "Good luck. We'll email the winner.",
  }),

  // ───────── Events & RSVPs ─────────
  tpl({
    name: "Potluck Sign-up", slug: "potluck-sign-up", category: EVENTS, tags: ["potluck", "food", "community"],
    description: "Let guests say what they're bringing so nothing gets doubled.",
    look: "warm_friendly", layout: "guided", brand: "#B5421A",
    steps: [{
      title: "What are you bringing?", description: "So we don't end up with five desserts.",
      fields: [
        text("Your name", R), email("Email", R),
        choice("Type of dish", ["Main", "Side", "Dessert", "Drinks", "Something else"], R),
        text("What exactly?", R), num("Servings", { min: 1, max: 100 }),
        text("Allergens or dietary notes"),
      ],
    }],
    submit: "Add my dish", headline: "Thank you", message: "See you there.",
  }),
  tpl({
    name: "Call for Speakers", slug: "call-for-speakers", category: EVENTS, tags: ["conference", "speaker", "proposal"],
    description: "Collect talk proposals with a short bio and the audience level.",
    look: "editorial", layout: "steps",
    steps: [
      {
        title: "About you",
        fields: [text("Full name", R), email("Email", R), longText("Short bio", R), url("Website or social profile")],
      },
      {
        title: "Your talk",
        fields: [
          text("Talk title", R),
          choice("Format", ["Talk", "Workshop", "Panel", "Lightning talk"], R),
          longText("Abstract", { required: true, help: "What will people learn?" }),
          choice("Audience level", ["Beginner", "Intermediate", "Advanced", "All levels"], R),
          url("A recording of a past talk"),
        ],
      },
    ],
    submit: "Send proposal", next: "Next", back: "Back", headline: "Proposal received",
    message: "Thank you. We'll be in touch once we've reviewed all proposals.",
  }),
  tpl({
    name: "Vendor Booth Registration", slug: "vendor-booth-registration", category: EVENTS, tags: ["market", "vendor", "booth"],
    description: "Register a vendor for a market or event stall.",
    look: "warm_friendly", layout: "classic", brand: "#2F6B4F",
    steps: [
      {
        title: "Your business", description: "Tell us who you are.",
        fields: [text("Business name", R), text("Contact name", R), email("Email", R), phone("Phone", R), url("Website")],
      },
      {
        title: "Your booth",
        fields: [
          choice("Category", ["Food & drink", "Crafts & art", "Clothing", "Services", "Other"], R),
          choice("Booth size", ["Small", "Standard", "Large"], R),
          longText("What will you be selling?", R), yesNo("Do you need power?", R),
        ],
      },
    ],
    submit: "Book my booth", next: "Next", back: "Back", headline: "Request received", message: "We'll confirm your spot shortly.",
  }),
  tpl({
    name: "Baby Shower RSVP", slug: "baby-shower-rsvp", category: EVENTS, tags: ["baby-shower", "rsvp", "personal"],
    description: "A warm RSVP for a baby shower, with dietary needs and a note for the parents.",
    look: "playful_bright", layout: "chat", brand: "#C93A21",
    steps: [{
      title: "Will you celebrate with us?",
      fields: [
        text("Your name", R), choice("Can you make it?", ["Yes!", "Maybe", "Can't make it"], R),
        num("Number of guests", { min: 1, max: 6, help: "Including yourself." }),
        text("Dietary needs"), longText("A note for the parents"),
      ],
    }],
    submit: "Send my reply", headline: "Thank you!", confetti: true, message: "We can't wait to celebrate with you.",
  }),

  // ───────── Bookings ─────────
  tpl({
    name: "Photo Session Booking", slug: "photo-session-booking", category: BOOKINGS, tags: ["photography", "session", "booking"],
    description: "Take booking requests for portrait, family or event shoots.",
    look: "editorial", layout: "split_feature",
    steps: [{
      title: "Book a session", description: "Tell me what you have in mind.",
      fields: [
        text("Name", R), email("Email", R), phone("Phone"),
        choice("Type of session", ["Portrait", "Family", "Event", "Product"], R),
        date("Preferred date", R), choice("Where?", ["Studio", "Outdoors", "At my place"]),
        longText("Anything else I should know?"),
      ],
    }],
    submit: "Request session", headline: "Request received", message: "I'll reply by email to confirm.",
  }),
  tpl({
    name: "Salon or Spa Booking", slug: "salon-spa-booking", category: BOOKINGS, tags: ["salon", "spa", "wellness"],
    description: "Take treatment bookings with a preferred time and any allergies.",
    look: "calm_care", layout: "steps",
    steps: [
      {
        title: "Your treatment",
        fields: [
          choice("Treatment", ["Haircut", "Colour", "Facial", "Massage", "Other"], R),
          dateTime("Preferred date and time", R), text("Preferred specialist"),
        ],
      },
      {
        title: "About you",
        fields: [text("Name", R), phone("Phone", R), email("Email", R), longText("Allergies or notes")],
      },
    ],
    submit: "Request booking", next: "Next", back: "Back", headline: "Request received",
    message: "We'll confirm your booking by email or phone.",
  }),
  tpl({
    name: "Class Trial Booking", slug: "class-trial-booking", category: BOOKINGS, tags: ["class", "trial", "fitness"],
    description: "Let people book a trial class and say how much experience they have.",
    look: "warm_friendly", layout: "classic",
    steps: [{
      title: "Try a class",
      fields: [
        text("Name", R), email("Email", R), phone("Phone", R), text("Which class?", R),
        date("Preferred date", R),
        choice("Your experience", ["First time", "Some experience", "Experienced"], R),
      ],
    }],
    submit: "Book my trial", headline: "Trial requested", message: "We'll confirm the class time by email.",
  }),

  // ───────── Feedback & Surveys ─────────
  tpl({
    name: "Product Beta Feedback", slug: "product-beta-feedback", category: FEEDBACK, tags: ["beta", "product", "feedback"],
    description: "Ask beta testers what they tried, what broke and what's missing.",
    look: "dark_tech", layout: "focus",
    steps: [{
      title: "How's the beta?",
      fields: [
        rating("Overall", R), longText("What did you try?"),
        longText("What was confusing or broken?"), longText("What's missing?"),
        email("Email", { help: "Only if we can follow up." }), yesNo("Can we contact you about this?"),
      ],
    }],
    submit: "Send feedback", headline: "Thank you", message: "This goes straight to the team.",
  }),
  tpl({
    name: "Feature Request", slug: "feature-request", category: FEEDBACK, tags: ["product", "request"],
    description: "Collect feature ideas along with the problem behind them.",
    look: "dark_tech", layout: "focus",
    steps: [{
      title: "Suggest a feature",
      fields: [
        text("What would you call it?", R),
        longText("What problem would it solve?", R),
        longText("How do you work around it today?"),
        choice("How important is it?", ["Nice to have", "Important", "Blocking me"], R),
        email("Email", { help: "Only if you'd like updates." }),
      ],
    }],
    submit: "Send idea", headline: "Thank you", message: "We read every request.",
  }),
  tpl({
    name: "Employee Pulse", slug: "employee-pulse", category: FEEDBACK, tags: ["employee", "pulse", "hr"],
    description: "A one-minute check-in on how work feels this week.",
    look: "clean_corporate", layout: "guided",
    steps: [{
      title: "How's work this week?", description: "We don't ask for your name.",
      fields: [
        rating("How are you feeling about work?", R),
        yesNo("Do you have what you need to do your job well?", R),
        choice("Your workload", ["Too light", "About right", "Too heavy"], R),
        longText("One thing we could improve"),
      ],
    }],
    submit: "Send", headline: "Thank you", message: "Your answer helps us improve.",
  }),
  tpl({
    name: "Suggestion Box", slug: "suggestion-box", category: FEEDBACK, tags: ["suggestion", "feedback"],
    description: "A simple box for ideas and concerns. It does not ask for a name or an email.",
    look: "minimal_paper", layout: "open",
    steps: [{
      title: "Suggestion box", description: "We don't ask for your name or email.",
      fields: [
        choice("About", ["Workplace", "Product", "Other"], R),
        longText("Your suggestion", R),
      ],
    }],
    submit: "Send suggestion", headline: "Thank you", message: "We read every suggestion.",
  }),

  // ───────── Education ─────────
  tpl({
    name: "Admission Enquiry", slug: "admission-enquiry", category: EDU, tags: ["admission", "school", "enquiry"],
    description: "Let parents or students ask about places and programmes.",
    look: "warm_friendly", layout: "classic", brand: "#1F6F6B",
    steps: [{
      title: "Ask about admission", description: "We'll get back to you with the details.",
      fields: [
        text("Parent or student name", R), email("Email", R), phone("Phone", R),
        text("Student's age or grade", R), text("Programme or class"), longText("Your question"),
      ],
    }],
    submit: "Send enquiry", headline: "Thank you", message: "Our admissions team will be in touch.",
  }),
  tpl({
    name: "Permission Slip", slug: "permission-slip", category: EDU, tags: ["school", "permission", "consent"],
    description: "Get a parent's signed permission for a trip or activity.",
    look: "calm_care", layout: "classic",
    steps: [
      {
        title: "The activity", description: SAMPLE,
        fields: [text("Student's name", R), text("Class or grade", R), text("Trip or activity", R)],
      },
      {
        title: "Permission",
        fields: [
          text("Parent or guardian name", R), phone("Emergency phone", R),
          longText("Medical or allergy notes", { help: "Anything the staff should know." }),
          yesNo("I give permission for my child to take part", R), signature("Signature", R),
        ],
      },
    ],
    submit: "Sign and send", next: "Next", back: "Back", headline: "Thank you", message: "Your permission has been recorded.",
  }),
  tpl({
    name: "Summer Camp Registration", slug: "summer-camp-registration", category: EDU, tags: ["camp", "kids", "registration"],
    description: "Register a child for camp, with health notes and emergency contacts.",
    look: "warm_friendly", layout: "steps", brand: "#2F6B4F",
    steps: [
      {
        title: "The camper", description: SAMPLE,
        fields: [
          text("Camper's name", R), date("Date of birth", R),
          multi("Which weeks?", ["Week 1", "Week 2", "Week 3", "Week 4"], R),
        ],
      },
      { title: "Parent or guardian", fields: [text("Name", R), email("Email", R), phone("Phone", R)] },
      {
        title: "Health and safety",
        fields: [
          longText("Allergies or medical needs"), text("Emergency contact name", R),
          phone("Emergency contact phone", R), yesNo("Photos may be taken for camp use", R),
        ],
      },
    ],
    submit: "Register", next: "Next", back: "Back", headline: "Registered", message: "We'll email the camp details.",
  }),
  tpl({
    name: "Assignment Submission", slug: "assignment-submission", category: EDU, tags: ["assignment", "upload", "school"],
    description: "Let students hand in a file with their name and a note.",
    look: "clean_corporate", layout: "classic",
    steps: [{
      title: "Submit your assignment",
      fields: [
        text("Your name", R), email("Email", R), text("Assignment title", R),
        fileUpload("Your file", ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
          { required: true, help: "PDF or Word, up to 10 MB." }),
        longText("Note for the teacher"),
      ],
    }],
    submit: "Hand in", headline: "Submitted", message: "Your work has been received.",
  }),

  // ───────── Fun & Polls ─────────
  tpl({
    name: "Secret Santa", slug: "secret-santa", category: FUN, tags: ["gift", "holiday", "group"],
    description: "Collect names and gift ideas for a Secret Santa draw.",
    look: "playful_bright", layout: "chat",
    steps: [{
      title: "Join the Secret Santa", description: "Tell us what you'd like.",
      fields: [
        text("Your name", R), email("Email", R),
        longText("Three things you'd love", R), longText("Anything to avoid?"),
      ],
    }],
    submit: "Count me in", headline: "You're in!", confetti: true, message: "We'll email you your match.",
  }),
  tpl({
    name: "Group Trip Planner", slug: "group-trip-planner", category: FUN, tags: ["trip", "travel", "group"],
    description: "Find out when everyone is free, what they like and what they'll spend.",
    look: "playful_bright", layout: "guided",
    steps: [{
      title: "Plan our trip", description: "Pick what suits you.",
      fields: [
        text("Your name", R), text("Dates that work for you", R),
        choice("Budget", ["Tight", "Comfortable", "Flexible"], R),
        multi("What do you want to do?", ["Beach", "City", "Hiking", "Food", "Relaxing"]),
        longText("Anything that's a dealbreaker?"),
      ],
    }],
    submit: "Send my answers", headline: "Thanks!", message: "We'll share the plan once everyone has replied.",
  }),
  tpl({
    name: "Movie or Dinner Poll", slug: "movie-or-dinner-poll", category: FUN, tags: ["poll", "plans", "group"],
    description: "Let friends vote on what to do and which day works.",
    look: "playful_bright", layout: "focus",
    steps: [{
      title: "What shall we do?",
      fields: [
        text("Your name", R),
        choice("Pick one", ["Dinner out", "Movie night", "Game night", "Something else"], R),
        multi("Which days work?", ["Friday", "Saturday", "Sunday"], R),
      ],
    }],
    submit: "Vote", headline: "Vote counted", message: "We'll share the result soon.",
  }),
  tpl({
    name: "This-or-That Poll", slug: "this-or-that-poll", category: FUN, tags: ["poll", "fun", "icebreaker"],
    description: "Five quick either-or questions, good for icebreakers.",
    look: "playful_bright", layout: "focus",
    steps: [{
      title: "This or that?",
      fields: [
        choice("Coffee or tea?", ["Coffee", "Tea"], R),
        choice("Beach or mountains?", ["Beach", "Mountains"], R),
        choice("Early bird or night owl?", ["Early bird", "Night owl"], R),
        choice("Sweet or savoury?", ["Sweet", "Savoury"], R),
        text("Your name"),
      ],
    }],
    submit: "Done", headline: "Thanks!", confetti: true, message: "Your answers are in.",
  }),
  tpl({
    name: "Roast & Toast Submissions", slug: "roast-toast-submissions", category: FUN, tags: ["party", "toast", "memories"],
    description: "Collect toasts, roasts and memories for a celebration.",
    look: "playful_bright", layout: "open",
    steps: [{
      title: "Say something about them", description: "Keep it kind. Roasts should be the loving kind.",
      fields: [
        text("Your name", R), text("Who is it for?", R),
        choice("What is it?", ["Toast", "Roast", "Memory"], R),
        longText("Your message", R), yesNo("OK to read it out loud?", R),
      ],
    }],
    submit: "Send it in", headline: "Thank you!", message: "We'll make sure it's heard.",
  }),
];
