import { IFormSettings } from "../models/Form";

const descriptions: Record<string, string> = {
  "Pitch": "Present your project, team, and business plan for review.",
  "Pitch Plan": "Present your project, team, and business plan for review.",
  "Contact Information Form": "Collect names, email addresses, phone numbers, and additional comments.",
  "Customer Feedback Survey": "Gather customer ratings, feedback, and recommendations.",
  "Job Application": "Collect applicant contact details, portfolio links, experience, and availability.",
  "Event Registration": "Register attendees and collect the details needed to plan your event.",
  "Product Order Form": "Collect product selections and customer order details.",
  "Master Comprehensive Template": "Explore a comprehensive form with multiple field types and validation options.",
};

export const getTemplateDescription = (name: string): string =>
  descriptions[name] || `Get started with the ${name} template.`;

export const getTemplateSettings = (): IFormSettings => ({
  layout: "single_column",
  successMessage: "Thank you! Your response has been submitted.",
  responseLimitEnabled: false,
  honeypotEnabled: false,
});
