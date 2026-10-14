export type ResumeLayoutColor = `#${string}`;

export type ResumeLayoutTemplate = {
  schemaVersion: "2.0";
  id: "sidebar-dark-header-color-v1";
  page: { format: "A4"; widthPt: number; heightPt: number; marginPt: number };
  palette: {
    sidebar: ResumeLayoutColor;
    main: "#FFFFFF";
    headerApprox: ResumeLayoutColor;
    text: "#111111";
  };
  columns: { sidebarWidthPt: number; gapPt: number; sidebarRepeats: true };
  header: { heightPt: number; nameUppercase: true };
  typography: { namePt: number; sectionPt: number; bodyPt: number };
  sections: ["summary", "experience", "education", "certifications"];
  sidebarSections: ["photo", "contact", "skills"];
  overflow: {
    wrapText: true;
    pageBreak: true;
    keepExperienceHeadingWithFirstBullet: true;
  };
  detection: {
    confidence: number;
    detectedColumns: 1 | 2;
    warnings: string[];
  };
};

export type ResumeLayoutTextBlock = {
  text: string;
  bbox: [number, number, number, number];
  spans: Array<{
    text: string;
    bbox: [number, number, number, number];
    fontName: string;
    fontSizePt: number;
    weight: "normal" | "bold";
  }>;
};

export type RawResumeExtraction = {
  schema_version: "1.0";
  source_file: { name: string; size_bytes: number };
  coordinate_system: "PDF points; origin at top-left";
  page: { format: "A4" | "custom"; width_pt: number; height_pt: number };
  template: {
    supported_template_id: ResumeLayoutTemplate["id"];
    detected_columns: 1 | 2;
    confidence: number;
  };
  images: { count: number; bytes_extracted: false; reused_in_output: false };
  pages: Array<{
    page_number: number;
    width_pt: number;
    height_pt: number;
    text_blocks: ResumeLayoutTextBlock[];
    drawings: {
      rectangle_count: number;
      fill_colors: string[];
      extracted_as_paths: false;
    };
  }>;
  usage: {
    ocr: false;
    source_pdf_retained: false;
    note: string;
  };
};

export type ResumeLayoutImportResponse = {
  templateId: string;
  template: ResumeLayoutTemplate;
  resumeText: string;
  layoutAvailable: boolean;
  rawExtraction: RawResumeExtraction;
  detectedSections: Array<{ label: string; pageNumber: number; confidence: number }>;
  expiresAt: string;
};

export const RESUME_LAYOUT_LIMITS = {
  maximumPdfBytes: 10 * 1024 * 1024,
  maximumPages: 30,
  maximumCharacters: 80_000,
  maximumTextBlocks: 12_000,
  templateLifetimeMs: 24 * 60 * 60_000,
} as const;
