// All 77 templates in one list. Import order sets sortOrder (Wave 1, then 2, then 3);
// the gallery shows featured templates first, then by sortOrder.
import { wave1Templates } from "./wave1Templates";
import { wave2Templates } from "./wave2Templates";
import { wave3Templates } from "./wave3Templates";

export const allTemplates = [...wave1Templates, ...wave2Templates, ...wave3Templates];
