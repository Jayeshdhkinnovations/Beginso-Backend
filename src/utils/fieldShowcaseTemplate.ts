// A built-in template that uses every field type, with the Display & Preview settings filled in, so each
// field (builder, respondent form and response viewer) can be tried from one form.
import type { IFormField } from "../models/Form";

const f = (pageId: string, label: string, type: IFormField["type"], extra: Partial<IFormField> = {}): IFormField => ({
  pageId,
  label,
  type,
  required: false,
  ...extra,
});

export const fieldShowcaseTemplate = {
  name: "Field Showcase (All Field Types)",
  category: "General",
  theme: "classic-light",
  isActive: true,
  pages: [
    { id: "page-1", order: 0, title: "About you", description: "Text, contact and choice fields." },
    { id: "page-2", order: 1, title: "Dates, money and links", description: "Date, time, currency, address and website fields." },
    { id: "page-3", order: 2, title: "Uploads and signature", description: "Images, a file and a signature." },
  ],
  fields: [
    f("page-1", "Full Name", "short_text", { required: true, placeholder: "e.g. Priya Sharma" }),
    f("page-1", "About You", "long_text", { placeholder: "A few sentences...", maxLength: 500 }),
    f("page-1", "Work Email", "email", { required: true, placeholder: "name@company.com" }),
    f("page-1", "Phone", "phone", { placeholder: "+91 98765 43210" }),
    f("page-1", "Team Size", "number", { min: 1, max: 1000 }),
    f("page-1", "Company Size", "dropdown", { options: ["1-10", "11-50", "51-200", "200+"] }),
    f("page-1", "Ticket", "multiple_choice", { options: ["General Admission", "VIP", "Student"] }),
    f("page-1", "Dietary Preference", "checkbox", { options: ["Vegetarian", "Vegan", "Gluten-free", "No preference"] }),
    f("page-1", "Would You Recommend Us?", "yes_no"),
    f("page-1", "Overall Rating", "rating", { helpText: "Tap a star. Tap it again to clear." }),
    f("page-2", "Preferred Date", "date"),
    f("page-2", "Preferred Time", "time"),
    f("page-2", "Booking Date & Time", "datetime"),
    f("page-2", "Budget", "currency", { currency: "INR", min: 0, placeholder: "50000" }),
    f("page-2", "Quote Amount (USD)", "currency", { currency: "USD", min: 0 }),
    f("page-2", "Delivery Address", "address"),
    f("page-2", "Event Website", "url", { urlPreviewStyle: "rich", urlDisplay: "card", placeholder: "https://example.com" }),
    f("page-2", "Portfolio Link", "url", { urlPreviewStyle: "compact", urlDisplay: "inline" }),
    f("page-2", "Social Profile", "url", { urlPreviewStyle: "text", urlDisplay: "inline" }),
    f("page-3", "Event Banner", "image_upload", {
      helpText: "Up to 5 images. Shown at the top of each response.",
      allowMultiple: true,
      maxImages: 5,
      previewPosition: "top",
      aspectRatio: "16:9",
      previewSize: "large",
    }),
    f("page-3", "Profile Photo", "image_upload", { allowMultiple: false, previewPosition: "inline", aspectRatio: "1:1", previewSize: "small" }),
    f("page-3", "Supporting Document", "file_upload", { maxFileSize: 10, allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"], helpText: "PDF, JPG or PNG." }),
    f("page-3", "Signature", "signature", { required: true, helpText: "Draw or type your signature." }),
  ],
};
