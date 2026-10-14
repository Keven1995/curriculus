import type { ResumeLayoutTemplate } from "./resume-layout-types.js";

export interface ResumeLayoutTemplateStore {
  storeTemporaryResumeLayout(templateId: string, template: ResumeLayoutTemplate): Promise<Date>;
  findTemporaryResumeLayout(templateId: string): Promise<ResumeLayoutTemplate | null>;
  deleteTemporaryResumeLayout(templateId: string): Promise<boolean>;
  deleteExpiredTemporaryResumeLayouts(): Promise<number>;
}
