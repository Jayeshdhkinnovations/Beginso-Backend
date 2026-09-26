import { IFormField, IFormSettings } from "../models/Form";

export interface Template {
  id: string;
  name: string;
  description: string;
  settings: IFormSettings;
  category: string;
  fields: IFormField[];
  theme: string;
  isActive: boolean;
}
